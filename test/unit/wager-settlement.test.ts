import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import type { WagerPayload } from '../../src/wagering/domain/wager-payload';
import { type SettlementContext, WagerSettlement } from '../../src/wagering/domain/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/wagering/domain/wager-transaction';
import { Wallet } from '../../src/wagering/domain/wallet';
import { LedgerDirection } from '../../src/wagering/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00Z');
const later = new Date(at.getTime() + 1000);
const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

let seq = 0;
function tx(kind: K, amount: string, overrides: Partial<WagerPayload> = {}): WagerTransaction {
  seq += 1;
  return WagerTransaction.create({
    id: `id-${seq}`,
    idempotencyKey: `key-${seq}`,
    createdAt: at,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-1',
    gameId: 'game',
    kind,
    money: brl(amount),
    ...overrides,
  });
}

function wallet(balance: string): Wallet {
  return Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: brl(balance), openingTransactionId: 'open', at }).wallet;
}

/** Uma referência que passou pela liquidação de verdade. */
function processed(kind: K, amount: string, w: Wallet, overrides: Partial<WagerPayload> = {}): WagerTransaction {
  const t = tx(kind, amount, overrides);
  run({ transaction: t, wallet: w, referenceAlreadyReversed: false });
  expect(t.status).toBe(S.Processed);
  return t;
}

function run(ctx: SettlementContext) {
  const decision = WagerSettlement.decide(ctx);
  const outcome = WagerSettlement.settle(ctx, decision, at, later);
  return { decision, outcome };
}

describe('BET', () => {
  test('debits the wallet and produces one DEBIT entry', () => {
    const w = wallet('100.00');
    const bet = tx(K.Bet, '25.00');
    const { outcome } = run({ transaction: bet, wallet: w, referenceAlreadyReversed: false });
    expect(outcome.type).toBe('processed');
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('75.00');
    expect(bet.status).toBe(S.Processed);
    expect(bet.resultingBalance?.amount).toBe('75.00');
  });

  test('is rejected with INSUFFICIENT_FUNDS and moves nothing', () => {
    const w = wallet('10.00');
    const bet = tx(K.Bet, '10.01');
    const { outcome } = run({ transaction: bet, wallet: w, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    expect(bet.status).toBe(S.Rejected);
  });

  test('can spend the exact balance', () => {
    const w = wallet('10.00');
    run({ transaction: tx(K.Bet, '10.00'), wallet: w, referenceAlreadyReversed: false });
    expect(w.balance.isZero()).toBe(true);
  });
});

describe('WIN', () => {
  test('credits without reference', () => {
    const w = wallet('0.00');
    const { outcome } = run({ transaction: tx(K.Win, '50.00'), wallet: w, referenceAlreadyReversed: false });
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('50.00');
  });

  test('may reference a BET of the same round', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '10.00', w);
    const win = tx(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run({ transaction: win, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('120.00');
  });

  test('referencing a BET of another round is a REFERENCE_MISMATCH', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '10.00', w, { roundId: 'round-2' });
    const win = tx(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const { outcome } = run({ transaction: win, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  test('is processed without moving the balance or creating an entry', () => {
    const w = wallet('100.00');
    const loss = tx(K.Loss, '10.00');
    const { outcome } = run({ transaction: loss, wallet: w, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'processed' });
    expect(loss.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits back a processed BET', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '40.00', w);
    const refund = tx(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run({ transaction: refund, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(refund.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
  });

  test('only references BET', () => {
    const w = wallet('100.00');
    const win = processed(K.Win, '40.00', w);
    const refund = tx(K.Refund, '40.00', { referenceExternalTransactionId: win.externalTransactionId });
    const { outcome } = run({ transaction: refund, wallet: w, reference: win, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReferenceInvalidKind });
  });

  test('only once', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '40.00', w);
    const refund = tx(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const { outcome } = run({ transaction: refund, wallet: w, reference: bet, referenceAlreadyReversed: true });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReferenceAlreadyReversed });
  });

  test('must match the referenced amount (no partial refunds)', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '40.00', w);
    const refund = tx(K.Refund, '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
    const { outcome } = run({ transaction: refund, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReferenceAmountMismatch });
  });

  test('of a REJECTED bet is REFERENCE_NOT_PROCESSED', () => {
    const w = wallet('10.00');
    const bet = tx(K.Bet, '40.00');
    run({ transaction: bet, wallet: w, referenceAlreadyReversed: false });
    expect(bet.status).toBe(S.Rejected);
    const refund = tx(K.Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const { outcome } = run({ transaction: refund, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotProcessed });
  });

  test('of another player/provider is REFERENCE_MISMATCH', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '40.00', w);
    const otherProvider = tx(K.Refund, '40.00', {
      providerId: 'provider-b',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(run({ transaction: otherProvider, wallet: w, reference: bet, referenceAlreadyReversed: false }).outcome).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceMismatch,
    });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits it back', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '30.00', w);
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const { outcome } = run({ transaction: rollback, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('of a WIN debits it back', () => {
    const w = wallet('0.00');
    const win = processed(K.Win, '30.00', w);
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: win.externalTransactionId });
    const { outcome } = run({ transaction: rollback, wallet: w, reference: win, referenceAlreadyReversed: false });
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('0.00');
  });

  test('of a REFUND debits it back', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '30.00', w);
    const refund = tx(K.Refund, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    run({ transaction: refund, wallet: w, reference: bet, referenceAlreadyReversed: false });
    expect(refund.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: refund.externalTransactionId });
    run({ transaction: rollback, wallet: w, reference: refund, referenceAlreadyReversed: false });
    expect(rollback.status).toBe(S.Processed);
  });

  test('that would make the balance negative is REVERSAL_INSUFFICIENT_FUNDS (distinct from a BET)', () => {
    const w = wallet('0.00');
    const win = processed(K.Win, '30.00', w);
    processed(K.Bet, '20.00', w); // o saldo agora é 10.00
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: win.externalTransactionId });
    const { outcome } = run({ transaction: rollback, wallet: w, reference: win, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe('10.00');
    expect(rollback.status).toBe(S.Rejected);
  });

  test('cannot target LOSS or another ROLLBACK', () => {
    const w = wallet('100.00');
    const loss = processed(K.Loss, '30.00', w);
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: loss.externalTransactionId });
    expect(run({ transaction: rollback, wallet: w, reference: loss, referenceAlreadyReversed: false }).outcome).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceInvalidKind,
    });
  });

  test('only once', () => {
    const w = wallet('100.00');
    const bet = processed(K.Bet, '30.00', w);
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(run({ transaction: rollback, wallet: w, reference: bet, referenceAlreadyReversed: true }).outcome).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });
});

describe('references that have not arrived', () => {
  test('missing reference → PENDING_REFERENCE without touching the balance', () => {
    const w = wallet('100.00');
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: 'not-yet' });
    const { outcome } = run({ transaction: rollback, wallet: w, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'pending_reference' });
    expect(rollback.status).toBe(S.PendingReference);
    expect(rollback.nextReferenceAttemptAt).toEqual(later);
    expect(w.version).toBe(1);
  });

  test('reference that is itself pending → keep waiting', () => {
    const w = wallet('100.00');
    const pendingRefund = tx(K.Refund, '30.00', { referenceExternalTransactionId: 'bet-not-yet' });
    run({ transaction: pendingRefund, wallet: w, referenceAlreadyReversed: false });
    const rollback = tx(K.Rollback, '30.00', { referenceExternalTransactionId: pendingRefund.externalTransactionId });
    expect(run({ transaction: rollback, wallet: w, reference: pendingRefund, referenceAlreadyReversed: false }).outcome).toEqual({
      type: 'pending_reference',
    });
  });
});

describe('scope checks', () => {
  test('currency conflict is rejected with CURRENCY_MISMATCH', () => {
    const w = wallet('100.00');
    const usdBet = tx(K.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) });
    const { outcome } = run({ transaction: usdBet, wallet: w, referenceAlreadyReversed: false });
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(w.balance.amount).toBe('100.00');
  });

  test('player that does not own the wallet is rejected', () => {
    const w = wallet('100.00');
    const bet = tx(K.Bet, '10.00', { playerId: '0192f28f-0000-7000-8000-000000000000' });
    expect(run({ transaction: bet, wallet: w, referenceAlreadyReversed: false }).outcome).toEqual({
      type: 'rejected',
      code: FailureCode.PlayerWalletMismatch,
    });
  });
});
