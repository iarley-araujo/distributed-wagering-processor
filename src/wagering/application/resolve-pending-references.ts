import type { BackoffPolicy } from '../../shared/domain/backoff';
import { AppLogger } from '../../observability/logger';
import { logContext } from '../../observability/log-context';
import { FailureCode } from '../domain/failure-code';
import { type SettlementDecision, WagerSettlement } from '../domain/wager-settlement';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import type { Clock, UnitOfWork, WageringTelemetry } from './ports';
import { loadReference, writeSettlementEffects } from './settlement-writer';

export interface PendingReferencePolicy {
  backoff: BackoffPolicy;
  /** Quantas vezes o worker reconfere antes de desistir com REFERENCE_NOT_FOUND. */
  maxAttempts: number;
}

export type ResolveResult = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

/**
 * Reavalia as transações PENDING_REFERENCE cuja próxima tentativa já venceu. Cada uma
 * roda na sua própria unidade de trabalho com o lock da wallet, igual a uma primeira tentativa,
 * então o worker pode rodar em quantas instâncias for: duas instâncias pegando a mesma linha
 * se serializam no lock da wallet e a segunda vê que ela já não está pendente.
 */
export class ResolvePendingReferences {
  private readonly logger = new AppLogger('ResolvePendingReferences');

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly telemetry: WageringTelemetry,
    private readonly policy: PendingReferencePolicy,
  ) {}

  async runOnce(batchSize: number): Promise<Record<ResolveResult, number>> {
    const due = await this.uow.run((scope) => scope.transactions.findDuePendingReferences(this.clock.now(), batchSize), {
      readOnly: true,
    });
    const totals: Record<ResolveResult, number> = { processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };
    for (const item of due) {
      const result = await logContext.run(
        { correlationId: `pending-ref:${item.id}`, transactionId: item.id, walletId: item.walletId },
        () => this.resolveOne(item.id, item.walletId),
      );
      totals[result] += 1;
    }
    return totals;
  }

  async resolveOne(transactionId: string, walletId: string): Promise<ResolveResult> {
    const result = await this.uow.run(async (scope): Promise<ResolveResult> => {
      const wallet = await scope.wallets.lockById(walletId);
      const transaction = await scope.transactions.findById(transactionId);
      const now = this.clock.now();
      if (
        !wallet ||
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        (transaction.nextReferenceAttemptAt && transaction.nextReferenceAttemptAt > now)
      ) {
        return 'skipped';
      }

      const walletVersionBefore = wallet.version;
      const { reference, referenceAlreadyReversed } = await loadReference(scope, transaction);
      const context = { transaction, wallet, reference, referenceAlreadyReversed };
      let decision: SettlementDecision = WagerSettlement.decide(context);
      const attempt = transaction.referenceAttempts + 1;
      if (decision.type === 'await_reference' && attempt >= this.policy.maxAttempts) {
        decision = {
          type: 'reject',
          code: reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound,
        };
      }
      const outcome = WagerSettlement.settle(
        context,
        decision,
        now,
        new Date(now.getTime() + this.policy.backoff.delayMs(attempt + 1)),
      );

      await scope.transactions.update(transaction, WagerTransactionStatus.PendingReference);
      await writeSettlementEffects(scope, {
        transaction,
        wallet,
        walletVersionBefore,
        outcome,
        eventContext: { correlationId: `pending-ref:${transaction.id}`, causationId: transaction.id, occurredAt: now },
        announcePending: false,
      });

      if (outcome.type !== 'pending_reference') {
        this.telemetry.transactionSettled({ kind: transaction.kind, status: transaction.status, source: 'worker' });
        this.logger.info('pending reference resolved', {
          kind: transaction.kind,
          status: transaction.status,
          failureCode: transaction.failureCode,
          attempts: attempt,
        });
      }
      return outcome.type === 'processed' ? 'processed' : outcome.type === 'rejected' ? 'rejected' : 'rescheduled';
    });
    return result;
  }
}
