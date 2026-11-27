import type { ReconciliationReport } from '../../application/reconcile-wallet';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

/**
 * Status HTTP por desfecho da transação — o provedor decide o que fazer só pelo
 * status code:
 *   201 PROCESSED (new)      200 PROCESSED (replay)
 *   202 PENDING_REFERENCE    aceita, vai liquidar de forma assíncrona; consultar o GET ou esperar os eventos
 *   422 REJECTED             regra de negócio; não reenviar o mesmo payload
 *   500 FAILED               falha terminal de infraestrutura registrada para auditoria
 */
export function statusCodeFor(tx: WagerTransaction, replay: boolean): number {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return replay ? 200 : 201;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function presentSubmission(tx: WagerTransaction, replay: boolean) {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    balance: tx.resultingBalance?.toJSON() ?? null,
    idempotentReplay: replay,
  };
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    resultingBalance: tx.resultingBalance?.toJSON() ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentReconciliation(report: ReconciliationReport) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    walletVersion: report.walletVersion,
    lastLedgerVersion: report.lastLedgerVersion,
    checkedAt: report.checkedAt.toISOString(),
  };
}
