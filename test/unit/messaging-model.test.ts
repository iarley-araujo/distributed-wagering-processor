import { describe, expect, test } from 'bun:test';
import { ExponentialBackoff } from '../../src/shared/domain/backoff';
import { canonicalJson } from '../../src/shared/domain/canonical-json';
import { InvalidTransactionStateError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../src/wagering/domain/events';
import { InboxMessage } from '../../src/wagering/domain/inbox-message';
import { OutboxMessage } from '../../src/wagering/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../src/wagering/domain/wager-transaction';
import { Wallet } from '../../src/wagering/domain/wallet';
import { RequestValidationError, toWagerPayload, wagerDataSchema } from '../../src/wagering/interfaces/contracts';

const at = new Date('2026-07-29T15:00:00Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('canonical JSON', () => {
  test('sorts keys recursively and omits undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe('ExponentialBackoff', () => {
  test('grows exponentially and caps', () => {
    const b = new ExponentialBackoff(100, 1000, false);
    expect([1, 2, 3, 4, 5, 6].map((n) => b.delayMs(n))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });
  test('jitter stays within [d/2, d]', () => {
    const b = new ExponentialBackoff(1000, 60_000, true, () => 0.999);
    expect(b.delayMs(3)).toBeLessThanOrEqual(4000);
    expect(new ExponentialBackoff(1000, 60_000, true, () => 0).delayMs(3)).toBe(2000);
  });
});

describe('Integration events', () => {
  const { wallet } = Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('100.00'), openingTransactionId: 'o', at });
  const bet = WagerTransaction.create({
    id: 't-1',
    idempotencyKey: 'k',
    createdAt: at,
    providerId: 'provider-a',
    externalTransactionId: 'e-1',
    playerId: 'p-1',
    walletId: 'w-1',
    roundId: 'r',
    gameId: 'g',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
  });
  const entry = wallet.debit(bet.money, bet.id, at);
  bet.markProcessed(undefined, at, wallet.balance);
  const ctx = { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: at };

  test('eventType and version live on the type; data carries MoneyProps strings', () => {
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = event.toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe('2026-07-29T15:00:00.000Z');
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('msg-1');
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('outbox id is the event id; payload is the serialized envelope', () => {
    const event = WagerTransactionProcessed.from(bet, wallet, ctx);
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.id).toBe(event.eventId);
    expect(outbox.aggregateId).toBe('w-1');
    expect(outbox.payload.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.isDue(at)).toBe(true);
  });

  test('outbox retry schedule and publication', () => {
    const outbox = OutboxMessage.enqueue(WagerTransactionProcessed.from(bet, wallet, ctx));
    outbox.scheduleRetry(at, new ExponentialBackoff(1000, 60_000, false));
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(at)).toBe(false);
    expect(outbox.isDue(new Date(at.getTime() + 1000))).toBe(true);
    outbox.markPublished(at);
    expect(outbox.isPending()).toBe(false);
    expect(() => outbox.markPublished(at)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  test('marks processed once and detects body changes', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(at)).toThrow(InvalidTransactionStateError);
    expect(inbox.matchesPayload('h')).toBe(true);
    expect(inbox.matchesPayload('other')).toBe(false);
  });
});

describe('wire contract', () => {
  const valid = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const parse = (data: unknown) => toWagerPayload(wagerDataSchema.parse(data));

  test('accepts the documented payload', () => {
    expect(parse(valid).money.amount).toBe('25.00');
  });
  test('rejects OPENING and unknown fields', () => {
    expect(wagerDataSchema.safeParse({ ...valid, kind: 'OPENING' }).success).toBe(false);
    expect(wagerDataSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(wagerDataSchema.safeParse({ ...valid, providerId: '__internal__' }).success).toBe(false);
  });
  test('rejects numeric money and bad amounts with a precise path', () => {
    expect(wagerDataSchema.safeParse({ ...valid, money: { amount: 25, currency: 'BRL' } }).success).toBe(false);
    try {
      parse({ ...valid, money: { amount: '1e2', currency: 'BRL' } });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).issues[0]?.path).toBe('money');
    }
  });
  test('REFUND without reference is invalid', () => {
    expect(() => parse({ ...valid, kind: 'REFUND' })).toThrow(RequestValidationError);
  });
});
