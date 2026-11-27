import { describe, expect, test } from 'bun:test';
import { DomainValidationError, InvalidTransactionStateError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { computePayloadHash, type WagerPayload } from '../../src/wagering/domain/wager-payload';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../src/wagering/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00Z');

export function payload(overrides: Partial<WagerPayload> = {}): WagerPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    ...overrides,
  };
}

const create = (overrides: Partial<WagerPayload> = {}) =>
  WagerTransaction.create({ id: 'tx-1', idempotencyKey: 'provider-a:transaction-123', createdAt: at, ...payload(overrides) });

describe('WagerTransaction', () => {
  test('is born PENDING', () => {
    const tx = create();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('OPENING cannot be created through the public factory', () => {
    expect(() => create({ kind: WagerTransactionKind.Opening })).toThrow(DomainValidationError);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => create({ kind: WagerTransactionKind.Refund })).toThrow(DomainValidationError);
    expect(() => create({ kind: WagerTransactionKind.Rollback })).toThrow(DomainValidationError);
    expect(create({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('rejects zero amount and self-reference', () => {
    expect(() => create({ money: brl('0.00') })).toThrow(DomainValidationError);
    expect(() => create({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'transaction-123' })).toThrow(
      DomainValidationError,
    );
  });

  test.each([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed])(
    'terminal status %s refuses every transition',
    (terminal) => {
      const tx = create();
      if (terminal === WagerTransactionStatus.Processed) tx.markProcessed(undefined, at, brl('1.00'));
      if (terminal === WagerTransactionStatus.Rejected) tx.reject(FailureCode.InsufficientFunds, at, brl('1.00'));
      if (terminal === WagerTransactionStatus.Failed) tx.fail(FailureCode.ProcessingRetriesExhausted, at);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, at, brl('1.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, at, undefined)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingRetriesExhausted, at)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(at, brl('1.00'))).toThrow(InvalidTransactionStateError);
    },
  );

  test('PENDING_REFERENCE can be rescheduled (attempts + 1) and then settled', () => {
    const tx = create({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(new Date(at.getTime() + 1000), brl('10.00'));
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    tx.markPendingReference(new Date(at.getTime() + 3000), brl('10.00'));
    expect(tx.referenceAttempts).toBe(1);
    tx.markProcessed('ref-id', at, brl('35.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.referenceTransactionId).toBe('ref-id');
  });

  test('reject and fail only accept codes of their category', () => {
    expect(() => create().reject(FailureCode.ProcessingRetriesExhausted, at, undefined)).toThrow(InvalidTransactionStateError);
    expect(() => create().fail(FailureCode.InsufficientFunds, at)).toThrow(InvalidTransactionStateError);
  });

  test('domain queries', () => {
    expect(create({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(create({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(true);
    expect(create({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const bet = create({ kind: WagerTransactionKind.Bet });
    const win = create({ kind: WagerTransactionKind.Win, externalTransactionId: 'w' });
    const rollback = create({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe('payload hash', () => {
  test('is stable under key order and amount formatting', () => {
    const a = computePayloadHash(payload());
    const b = computePayloadHash({ ...payload(), money: brl('25') });
    expect(a).toBe(b);
  });

  test('changes with any business field', () => {
    const base = computePayloadHash(payload());
    expect(computePayloadHash(payload({ money: brl('25.01') }))).not.toBe(base);
    expect(computePayloadHash(payload({ roundId: 'other' }))).not.toBe(base);
    expect(computePayloadHash(payload({ kind: WagerTransactionKind.Win }))).not.toBe(base);
    expect(computePayloadHash(payload({ money: Money.from({ amount: '25.00', currency: 'USD' }) }))).not.toBe(base);
    expect(computePayloadHash(payload({ referenceExternalTransactionId: 'x' }))).not.toBe(base);
  });

  test('same idempotency key with a divergent payload is detected', () => {
    const original = create();
    const divergent = create({ money: brl('26.00') });
    expect(original.idempotencyKey).toBe(divergent.idempotencyKey);
    expect(original.matchesPayload(divergent.payloadHash)).toBe(false);
    expect(original.matchesPayload(create().payloadHash)).toBe(true);
  });
});
