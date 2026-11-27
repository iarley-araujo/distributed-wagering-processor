import { InvariantViolationError } from '../../shared/domain/errors';
import { uuidv7 } from '../../shared/domain/ids';
import { Money } from '../../shared/domain/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  /** Versão da wallet depois deste movimento. Única por wallet: um lançamento por mudança de saldo. */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
  balanceAfter: Money;
}

/**
 * Registro append-only de um movimento de saldo. Imutável na estrutura: todo campo é
 * readonly e não existe método de transição. O banco garante a mesma coisa
 * (trigger sem UPDATE/DELETE/TRUNCATE, CHECK da aritmética).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const signed = props.direction === LedgerDirection.Debit ? props.money.negate() : props.money;
    const entry = new WalletLedgerEntry(
      uuidv7(props.createdAt.getTime()),
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceBefore.add(signed),
      props.walletVersion,
      props.createdAt,
    );
    entry.assertValid();
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** `balanceBefore ± money === balanceAfter` */
  isBalanced(): boolean {
    const signed = this.direction === LedgerDirection.Debit ? this.money.negate() : this.money;
    return this.balanceBefore.add(signed).equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo: +money para crédito, -money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Debit ? this.money.negate() : this.money;
  }

  private assertValid(): void {
    if (!this.money.isPositive()) {
      throw new InvariantViolationError('Ledger entry amount must be positive');
    }
    if (this.balanceBefore.isNegative() || this.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger entry would make the balance negative');
    }
    if (!Number.isInteger(this.walletVersion) || this.walletVersion < 1) {
      throw new InvariantViolationError('Ledger entry wallet version must be a positive integer');
    }
    if (!this.isBalanced()) {
      throw new InvariantViolationError('Ledger entry is not balanced');
    }
  }
}
