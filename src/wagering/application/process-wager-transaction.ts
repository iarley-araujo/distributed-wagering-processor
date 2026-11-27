// ㉿ O coração do sistema: toda operação de provedor (HTTP ou fila) passa por aqui.
import type { BackoffPolicy } from '../../shared/domain/backoff';
import { uuidv7 } from '../../shared/domain/ids';
import { AppLogger } from '../../observability/logger';
import { logContext } from '../../observability/log-context';
import type { EventContext } from '../domain/events';
import { InboxMessage } from '../domain/inbox-message';
import type { WagerPayload } from '../domain/wager-payload';
import { WagerSettlement } from '../domain/wager-settlement';
import { WagerTransaction } from '../domain/wager-transaction';
import { PermanentMessageError } from './errors';
import type {
  Clock,
  FaultInjector,
  TransactionScope,
  TransactionSource,
  UnitOfWork,
  WageringTelemetry,
} from './ports';
import { loadReference, writeSettlementEffects } from './settlement-writer';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
}

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  /** Hash do envelope inteiro da mensagem, para pegar um messageId reaproveitado com corpo diferente. */
  payloadHash: string;
}

export interface ProcessOptions {
  source: TransactionSource;
  correlationId: string;
  causationId?: string;
  inbox?: InboxReceipt;
}

export type ProcessWagerResult =
  | { type: 'completed'; transaction: WagerTransaction; replay: boolean }
  | { type: 'idempotency_conflict'; existingTransactionId: string }
  | { type: 'external_id_conflict'; existingTransactionId: string }
  | { type: 'wallet_not_found'; walletId: string }
  | { type: 'duplicate_message' };

/**
 * Ponto de entrada único das operações dos provedores — usado igualzinho pelo controller
 * HTTP e pelo consumer SQS. Uma chamada = uma transação SQL com (quando se aplica):
 * linha do inbox, linha da transação, lançamento no ledger, update da wallet e eventos no outbox.
 *
 * Protocolo de concorrência (por wallet, sem lock global):
 *  1. [SQS] INSERT no inbox ON CONFLICT DO NOTHING — uma duplicata concorrente fica presa no
 *     índice único até a primeira commitar, aí vê o conflito e para.
 *  2. Caminho rápido de idempotência sem lock: replay nunca encosta na linha quente da wallet.
 *  3. SELECT wallet FOR UPDATE — serializa todo mundo que escreve nessa wallet, em qualquer instância.
 *  4. Confere a idempotency key de novo já com o lock (em READ COMMITTED vejo o commit de quem tinha o lock antes).
 *  5. Decide com as regras puras do domínio e escreve: INSERT da transação ON CONFLICT DO NOTHING
 *     (pega o caso da mesma key vindo com outra wallet), lançamento no ledger,
 *     `UPDATE wallets ... WHERE version = :expected` condicional, outbox.
 *  6. COMMIT. O banco revalida saldo ≥ 0, a cadeia do ledger e se saldo e ledger batem.
 */
export class ProcessWagerTransaction {
  private readonly logger = new AppLogger('ProcessWagerTransaction');

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly telemetry: WageringTelemetry,
    private readonly faults: FaultInjector,
    private readonly referenceBackoff: BackoffPolicy,
  ) {}

  async execute(command: SubmitWagerCommand, options: ProcessOptions): Promise<ProcessWagerResult> {
    const startedAt = performance.now();
    const receivedAt = this.clock.now();
    // Valida kind (OPENING proibido), valor > 0 e exigência de referência antes de qualquer I/O.
    const candidate = WagerTransaction.create({
      id: uuidv7(receivedAt.getTime()),
      idempotencyKey: command.idempotencyKey,
      createdAt: receivedAt,
      ...command.payload,
    });

    const result = await this.uow.run(async (scope) => {
      let inbox: InboxMessage | undefined;
      if (options.inbox) {
        inbox = InboxMessage.receive({ ...options.inbox, receivedAt });
        if (!(await scope.inbox.tryInsert(inbox))) {
          const existing = await scope.inbox.find(options.inbox.consumerName, options.inbox.messageId);
          if (existing && !existing.matchesPayload(options.inbox.payloadHash)) {
            throw new PermanentMessageError(
              'INBOX_PAYLOAD_MISMATCH',
              `Message ${options.inbox.messageId} was already received with a different body`,
            );
          }
          this.telemetry.duplicateDetected('inbox');
          return { type: 'duplicate_message' } as const;
        }
      }

      const outcome = await this.settle(scope, candidate, options);

      if (inbox) {
        inbox.markProcessed(this.clock.now());
        await scope.inbox.markProcessed(inbox);
      }
      await this.faults.trigger('process.beforeCommit');
      return outcome;
    });

    this.report(result, options, startedAt);
    return result;
  }

  private async settle(
    scope: TransactionScope,
    candidate: WagerTransaction,
    options: ProcessOptions,
  ): Promise<ProcessWagerResult> {
    const fastPath = await scope.transactions.findByIdempotencyKey(candidate.idempotencyKey);
    if (fastPath) return this.replayOrConflict(fastPath, candidate);

    const lockStartedAt = performance.now();
    const wallet = await scope.wallets.lockById(candidate.walletId);
    this.telemetry.walletLockAcquired((performance.now() - lockStartedAt) / 1000);
    if (!wallet) return { type: 'wallet_not_found', walletId: candidate.walletId };

    const underLock = await scope.transactions.findByIdempotencyKey(candidate.idempotencyKey);
    if (underLock) return this.replayOrConflict(underLock, candidate);

    const now = this.clock.now();
    const walletVersionBefore = wallet.version;
    const { reference, referenceAlreadyReversed } = await loadReference(scope, candidate);
    const context = { transaction: candidate, wallet, reference, referenceAlreadyReversed };
    const decision = WagerSettlement.decide(context);
    const outcome = WagerSettlement.settle(
      context,
      decision,
      now,
      new Date(now.getTime() + this.referenceBackoff.delayMs(1)),
    );

    // Primeira escrita da unidade de trabalho. Se der conflito, nada foi gravado ainda e
    // a mudança da wallet em memória simplesmente é descartada.
    if (!(await scope.transactions.insertIfAbsent(candidate))) {
      const byKey = await scope.transactions.findByIdempotencyKey(candidate.idempotencyKey);
      if (byKey) return this.replayOrConflict(byKey, candidate);
      const byExternalId = await scope.transactions.findByExternalId(
        candidate.providerId,
        candidate.externalTransactionId,
      );
      return { type: 'external_id_conflict', existingTransactionId: byExternalId?.id ?? 'unknown' };
    }

    await writeSettlementEffects(scope, {
      transaction: candidate,
      wallet,
      walletVersionBefore,
      outcome,
      eventContext: this.eventContext(options, now),
      announcePending: true,
    });
    return { type: 'completed', transaction: candidate, replay: false };
  }

  private replayOrConflict(existing: WagerTransaction, candidate: WagerTransaction): ProcessWagerResult {
    if (!existing.matchesPayload(candidate.payloadHash)) {
      this.telemetry.idempotencyConflict();
      return { type: 'idempotency_conflict', existingTransactionId: existing.id };
    }
    this.telemetry.duplicateDetected('idempotency_key');
    return { type: 'completed', transaction: existing, replay: true };
  }

  private eventContext(options: ProcessOptions, occurredAt: Date): EventContext {
    return { correlationId: options.correlationId, causationId: options.causationId, occurredAt };
  }

  private report(result: ProcessWagerResult, options: ProcessOptions, startedAt: number): void {
    this.telemetry.processingDuration(options.source, (performance.now() - startedAt) / 1000);
    if (result.type === 'completed') {
      const tx = result.transaction;
      logContext.assign({ transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId });
      if (!result.replay) {
        this.telemetry.transactionSettled({ kind: tx.kind, status: tx.status, source: options.source });
      }
      this.logger.info('wager transaction handled', {
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
        idempotentReplay: result.replay,
        source: options.source,
      });
    } else {
      this.logger.warn('wager transaction not applied', { outcome: result.type, source: options.source });
    }
  }
}
