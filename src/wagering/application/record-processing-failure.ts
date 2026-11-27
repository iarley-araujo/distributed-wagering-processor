import { uuidv7 } from '../../shared/domain/ids';
import { AppLogger } from '../../observability/logger';
import { WagerTransactionFailed } from '../domain/events';
import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import type { InboxReceipt, SubmitWagerCommand } from './process-wager-transaction';
import type { Clock, UnitOfWork, WageringTelemetry } from './ports';

/**
 * Registra como transação FAILED (terminal, auditável) uma mensagem que estourou o
 * orçamento de processamento, antes dela ir pra DLQ — mas só se nada mais tiver sido
 * gravado para a idempotency key / external id dela. É best effort: se o problema é o
 * próprio banco, isso falha também e a DLQ sozinha guarda a evidência.
 */
export class RecordProcessingFailure {
  private readonly logger = new AppLogger('RecordProcessingFailure');

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly telemetry: WageringTelemetry,
  ) {}

  async execute(
    command: SubmitWagerCommand,
    inbox: InboxReceipt,
    correlationId: string,
  ): Promise<'recorded' | 'already_handled'> {
    const now = this.clock.now();
    const transaction = WagerTransaction.create({
      id: uuidv7(now.getTime()),
      idempotencyKey: command.idempotencyKey,
      createdAt: now,
      ...command.payload,
    });

    const outcome = await this.uow.run(async (scope) => {
      const message = InboxMessage.receive({ ...inbox, receivedAt: now });
      if (!(await scope.inbox.tryInsert(message))) return 'already_handled' as const;
      message.markProcessed(now);
      await scope.inbox.markProcessed(message);

      const wallet = await scope.wallets.findById(transaction.walletId);
      if (!wallet || (await scope.transactions.findByIdempotencyKey(transaction.idempotencyKey))) {
        return 'already_handled' as const;
      }
      transaction.fail(FailureCode.ProcessingRetriesExhausted, now);
      if (!(await scope.transactions.insertIfAbsent(transaction))) return 'already_handled' as const;
      await scope.outbox.enqueue([
        OutboxMessage.enqueue(
          WagerTransactionFailed.from(transaction, FailureCode.ProcessingRetriesExhausted, {
            correlationId,
            causationId: inbox.messageId,
            occurredAt: now,
          }),
        ),
      ]);
      return 'recorded' as const;
    });

    if (outcome === 'recorded') {
      this.telemetry.transactionSettled({ kind: transaction.kind, status: transaction.status, source: 'sqs' });
      this.logger.error('wager transaction marked FAILED', {
        transactionId: transaction.id,
        failureCode: FailureCode.ProcessingRetriesExhausted,
      });
    }
    return outcome;
  }
}
