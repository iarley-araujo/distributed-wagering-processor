import type { EventContext, IntegrationEvent } from '../domain/events';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransactionKind } from '../domain/wager-transaction';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { SettlementOutcome } from '../domain/wager-settlement';
import type { Wallet } from '../domain/wallet';
import type { TransactionScope } from './ports';

/**
 * Grava os efeitos de uma liquidação que são comuns à primeira tentativa e ao worker
 * de referências pendentes: lançamento no ledger, update condicional da wallet, eventos no
 * outbox e o "nudge" das transações que esperam por esta. Tem que rodar dentro da unidade
 * de trabalho que segura o lock da wallet e que já gravou a linha da transação.
 */
export async function writeSettlementEffects(
  scope: TransactionScope,
  input: {
    transaction: WagerTransaction;
    wallet: Wallet;
    walletVersionBefore: number;
    outcome: SettlementOutcome;
    eventContext: EventContext;
    /** Publica WagerTransactionPendingReference (só na primeira vez que fica pendente). */
    announcePending: boolean;
  },
): Promise<void> {
  const { transaction, wallet, outcome, eventContext } = input;
  const events: IntegrationEvent<unknown>[] = [];

  switch (outcome.type) {
    case 'processed':
      if (outcome.entry) {
        await scope.ledger.append(outcome.entry);
        await scope.wallets.saveBalance(wallet, input.walletVersionBefore);
      }
      events.push(WagerTransactionProcessed.from(transaction, wallet, eventContext));
      if (outcome.entry) {
        events.push(WalletBalanceChanged.from(wallet, outcome.entry, eventContext));
      }
      if (REFERENCEABLE_KINDS.has(transaction.kind)) {
        await scope.transactions.nudgePendingDependents(
          transaction.providerId,
          transaction.externalTransactionId,
          eventContext.occurredAt,
        );
      }
      break;
    case 'rejected':
      events.push(WagerTransactionRejected.from(transaction, outcome.code, eventContext));
      break;
    case 'pending_reference':
      if (input.announcePending) {
        events.push(WagerTransactionPendingReference.from(transaction, eventContext));
      }
      break;
  }

  await scope.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
}

const REFERENCEABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

/** Carrega a transação referenciada e se ela já foi revertida. */
export async function loadReference(
  scope: TransactionScope,
  transaction: WagerTransaction,
): Promise<{ reference?: WagerTransaction; referenceAlreadyReversed: boolean }> {
  if (transaction.referenceExternalTransactionId === undefined) {
    return { referenceAlreadyReversed: false };
  }
  const reference = await scope.transactions.findByExternalId(
    transaction.providerId,
    transaction.referenceExternalTransactionId,
  );
  if (!reference) {
    return { referenceAlreadyReversed: false };
  }
  const referenceAlreadyReversed = transaction.isReversal()
    ? await scope.transactions.hasProcessedReversal(reference.id)
    : false;
  return { reference, referenceAlreadyReversed };
}
