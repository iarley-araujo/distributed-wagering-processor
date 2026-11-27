import { InvalidCursorError, TransactionNotFoundError, WalletNotFoundError } from './errors';
import type { UnitOfWork } from './ports';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

/**
 * Cursor do ledger, opaco e estável: base64url({"w": walletId, "v": últimaVersãoVista}).
 * As páginas vão do mais novo pro mais antigo pela versão da wallet, que é única e imutável,
 * então o cursor nunca pula nem repete lançamento, mesmo com lançamentos novos entrando.
 */
export const LedgerCursor = {
  encode(walletId: string, walletVersion: number): string {
    return Buffer.from(JSON.stringify({ w: walletId, v: walletVersion }), 'utf8').toString('base64url');
  },
  decode(walletId: string, cursor: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { w?: unknown; v?: unknown };
      if (parsed.w !== walletId || typeof parsed.v !== 'number' || !Number.isInteger(parsed.v) || parsed.v < 1) {
        throw new InvalidCursorError();
      }
      return parsed.v;
    } catch {
      throw new InvalidCursorError();
    }
  },
};

export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  getWallet(walletId: string): Promise<Wallet> {
    return this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        return wallet;
      },
      { readOnly: true },
    );
  }

  getLedgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const beforeVersion = cursor ? LedgerCursor.decode(walletId, cursor) : undefined;
    return this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);
        // Busco uma linha a mais para saber se existe próxima página.
        const rows = await scope.ledger.page({ walletId, beforeVersion, limit: limit + 1 });
        const entries = rows.slice(0, limit);
        const last = entries.at(-1);
        const nextCursor = rows.length > limit && last ? LedgerCursor.encode(walletId, last.walletVersion) : null;
        return { entries, nextCursor };
      },
      { readOnly: true },
    );
  }

  getTransaction(transactionId: string): Promise<WagerTransaction> {
    return this.uow.run(
      async (scope) => {
        const tx = await scope.transactions.findById(transactionId);
        if (!tx) throw new TransactionNotFoundError(transactionId);
        return tx;
      },
      { readOnly: true },
    );
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.uow.run(
      async (scope) => {
        const tx = await scope.transactions.findByExternalId(providerId, externalTransactionId);
        if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
        return tx;
      },
      { readOnly: true },
    );
  }
}
