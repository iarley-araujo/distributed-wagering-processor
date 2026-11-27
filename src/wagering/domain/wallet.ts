// ㉿ Wallet: o aggregate que guarda o saldo e gera o ledger.
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id da transação interna OPENING; obrigatório quando initialBalance > 0. */
  openingTransactionId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Só existe quando o saldo inicial é positivo. */
  openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root. Dona do saldo materializado e a única que gera lançamentos no
 * ledger: `debit`/`credit` mudam o saldo e devolvem o lançamento correspondente no mesmo
 * passo, então saldo e ledger não têm como se desencontrar no código da aplicação.
 *
 * `version` é 1 depois da criação (o crédito de abertura, se houver, faz parte da criação) e
 * sobe exatamente um a cada mudança de saldo, o que também a torna a sequência do ledger.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('Initial balance cannot be negative');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, Money.zero(currency), 1, props.at, props.at);
    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    const openingEntry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: wallet._balance,
      walletVersion: 1,
      createdAt: props.at,
    });
    wallet._balance = openingEntry.balanceAfter;
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, at);
  }

  move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return direction === LedgerDirection.Debit
      ? this.debit(money, transactionId, at)
      : this.credit(money, transactionId, at);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = entry.balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
