import { uuidv7 } from '../../shared/domain/ids';
import type { Money } from '../../shared/domain/money';
import { AppLogger } from '../../observability/logger';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { Clock, UnitOfWork } from './ports';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

/**
 * Abre uma wallet. Saldo inicial positivo vira uma transação interna OPENING
 * + lançamento CREDIT no ledger, na mesma transação SQL da linha da wallet.
 * Wallet duplicada (playerId, currency) é barrada pela unique constraint, não por um pré-check.
 */
export class CreateWallet {
  private readonly logger = new AppLogger('CreateWallet');

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand, correlationId: string): Promise<Wallet> {
    const now = this.clock.now();
    const walletId = uuidv7(now.getTime());
    const openingTransactionId = uuidv7(now.getTime());
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      at: now,
    });

    await this.uow.run(async (scope) => {
      await scope.wallets.insert(wallet);
      if (!openingEntry) return;

      const opening = WagerTransaction.opening({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: openingEntry.money,
        at: now,
      });
      opening.markProcessed(undefined, now, wallet.balance);
      await scope.transactions.insertIfAbsent(opening);
      await scope.ledger.append(openingEntry);

      const ctx = { correlationId, causationId: wallet.id, occurredAt: now };
      await scope.outbox.enqueue([
        OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, ctx)),
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
      ]);
    });

    this.logger.info('wallet opened', { walletId: wallet.id, currency: wallet.currency });
    return wallet;
  }
}
