import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/wagering/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/wagering/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00Z');

function open(amount: string) {
  return Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(amount), openingTransactionId: 'tx-open', at });
}

describe('Wallet', () => {
  test('opens at version 1 with an opening CREDIT entry when the initial balance is positive', () => {
    const { wallet, openingEntry } = open('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = open('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('debit/credit return the matching ledger entry and bump version by one', () => {
    const { wallet } = open('100.00');
    const debit = wallet.debit(brl('80.00'), 'tx-1', at);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('20.00');
    expect(debit.walletVersion).toBe(2);
    expect(debit.isBalanced()).toBe(true);

    const credit = wallet.credit(brl('5.50'), 'tx-2', at);
    expect(wallet.balance.amount).toBe('25.50');
    expect(wallet.version).toBe(3);
    expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
  });

  test('never goes negative', () => {
    const { wallet } = open('100.00');
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(() => wallet.debit(brl('100.01'), 'tx', at)).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    wallet.debit(brl('100.00'), 'tx', at);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects operations in another currency', () => {
    const { wallet } = open('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.credit(usd, 'tx', at)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, 'tx', at)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('rehydrate restores state without revalidating', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(17);
    expect(wallet.balance.amount).toBe('42.00');
  });
});

describe('WalletLedgerEntry', () => {
  test('validates arithmetic and sign in the factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        walletVersion: 2,
        createdAt: at,
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 't',
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('5.00'),
        walletVersion: 2,
        createdAt: at,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('is structurally immutable (no setters, readonly fields)', () => {
    const entry = WalletLedgerEntry.create({
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      walletVersion: 1,
      createdAt: at,
    });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['assertValid', 'isBalanced', 'signedAmount']);
    // Um lançamento reidratado e desbalanceado é detectável
    const tampered = WalletLedgerEntry.rehydrate({ ...entry, balanceAfter: brl('2.00') });
    expect(tampered.isBalanced()).toBe(false);
  });
});
