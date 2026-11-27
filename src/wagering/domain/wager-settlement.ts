import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface SettlementContext {
  transaction: WagerTransaction;
  /** Wallet já travada. */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ainda não chegou. */
  reference?: WagerTransaction;
  /** Se a `reference` já tem um REFUND/ROLLBACK PROCESSED apontando para ela. */
  referenceAlreadyReversed: boolean;
}

export type SettlementDecision =
  | { type: 'apply'; direction: LedgerDirection; reference?: WagerTransaction }
  | { type: 'no_effect'; reference?: WagerTransaction }
  | { type: 'reject'; code: FailureCode }
  | { type: 'await_reference' };

export type SettlementOutcome =
  | { type: 'processed'; entry?: WalletLedgerEntry }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

/**
 * Regras de negócio puras de BET / WIN / LOSS / REFUND / ROLLBACK. Sem I/O: quem chama carrega
 * a wallet travada e a referência; aqui só decido e altero os aggregates.
 */
export const WagerSettlement = {
  decide(ctx: SettlementContext): SettlementDecision {
    const { transaction: tx, wallet, reference } = ctx;

    if (tx.money.currency !== wallet.currency) {
      return { type: 'reject', code: FailureCode.CurrencyMismatch };
    }
    if (tx.playerId !== wallet.playerId || tx.walletId !== wallet.id) {
      return { type: 'reject', code: FailureCode.PlayerWalletMismatch };
    }

    if (tx.referenceExternalTransactionId !== undefined) {
      if (!reference) {
        return { type: 'await_reference' };
      }
      const referenceProblem = WagerSettlement.validateReference(ctx, reference);
      if (referenceProblem) {
        return referenceProblem;
      }
    }

    if (!tx.affectsBalance()) {
      return { type: 'no_effect', reference };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      return {
        type: 'reject',
        code: tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds,
      };
    }
    return { type: 'apply', direction, reference };
  },

  /**
   * Aplica uma decisão nos aggregates. Retorna o lançamento do ledger quando o saldo mudou.
   * `nextReferenceAttemptAt` só é usado no caso `await_reference`.
   */
  settle(
    ctx: SettlementContext,
    decision: SettlementDecision,
    now: Date,
    nextReferenceAttemptAt: Date,
  ): SettlementOutcome {
    const { transaction: tx, wallet } = ctx;
    switch (decision.type) {
      case 'apply': {
        const entry = wallet.move(decision.direction, tx.money, tx.id, now);
        tx.markProcessed(decision.reference?.id, now, wallet.balance);
        return { type: 'processed', entry };
      }
      case 'no_effect':
        tx.markProcessed(decision.reference?.id, now, wallet.balance);
        return { type: 'processed' };
      case 'reject':
        tx.reject(decision.code, now, wallet.balance);
        return { type: 'rejected', code: decision.code };
      case 'await_reference':
        tx.markPendingReference(nextReferenceAttemptAt, wallet.balance);
        return { type: 'pending_reference' };
    }
  },

  validateReference(ctx: SettlementContext, reference: WagerTransaction): SettlementDecision | undefined {
    const tx = ctx.transaction;
    const sameScope =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameScope) {
      return { type: 'reject', code: FailureCode.ReferenceMismatch };
    }
    if (!tx.allowedReferenceKinds().has(reference.kind)) {
      return { type: 'reject', code: FailureCode.ReferenceInvalidKind };
    }
    if (reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
      // A própria referência está esperando (ex.: ROLLBACK de um REFUND cuja BET atrasou).
      return { type: 'await_reference' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { type: 'reject', code: FailureCode.ReferenceNotProcessed };
    }
    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) {
        return { type: 'reject', code: FailureCode.ReferenceAmountMismatch };
      }
      if (ctx.referenceAlreadyReversed) {
        return { type: 'reject', code: FailureCode.ReferenceAlreadyReversed };
      }
    }
    return undefined;
  },
};
