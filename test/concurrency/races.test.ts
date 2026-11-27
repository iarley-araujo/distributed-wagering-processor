import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createWallet,
  ensureSchema,
  eventually,
  expectConsistent,
  http,
  sendToQueue,
  setupQueues,
  sql,
  startApp,
  submit,
  testConfig,
  type TestApp,
  transactionsOf,
  uniquePrefix,
  wagerBody,
  wagerMessage,
} from '../support/harness';

/*
 * Paralelismo de verdade: as requisições são disparadas juntas com Promise.all via HTTP; três
 * instâncias da aplicação (apps Nest separados, pools de conexão separados) dividem o mesmo
 * banco e as mesmas filas. O único ponto de serialização é o PostgreSQL.
 */

let apps: TestApp[] = [];
const pick = (i: number) => apps[i % apps.length] as TestApp;

async function totalAcks(): Promise<number> {
  const counts = await Promise.all(
    apps.map(async (a) => {
      const text = await (await fetch(`${a.url}/metrics`)).text();
      return Number(text.match(/wagering_consumer_messages_total\{outcome="ack"\} (\d+)/)?.[1] ?? 0);
    }),
  );
  return counts.reduce((x, y) => x + y, 0);
}

beforeAll(async () => {
  await ensureSchema();
  const prefix = uniquePrefix('races');
  const config = testConfig(prefix, { PENDING_REF_MAX_ATTEMPTS: '4', DB_POOL_MAX: '30' });
  await setupQueues(config);
  apps = await Promise.all([0, 1, 2].map(() => startApp(config)));
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

describe('hot wallet', () => {
  test('mandatory scenario: 100.00, two simultaneous 80.00 bets → exactly one processed (repeated 20×)', async () => {
    for (let round = 0; round < 20; round++) {
      const { walletId, playerId } = await createWallet(pick(round).url, '100.00');
      const [a, b] = await Promise.all([
        submit(pick(round).url, wagerBody({ walletId, playerId, kind: 'BET', amount: '80.00' })),
        submit(pick(round + 1).url, wagerBody({ walletId, playerId, kind: 'BET', amount: '80.00' })),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      const rejected = [a, b].find((r) => r.status === 422);
      expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');

      const txs = await transactionsOf(walletId);
      expect(txs.map((t) => t.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
      const state = await expectConsistent(walletId);
      expect(state.balance).toBe('20.00');
      expect(state.debits).toBe(1);

      // repetir as duas requisições não muda nada
      const again = await Promise.all(
        txs.map((t) =>
          submit(pick(round).url, wagerBody({ walletId, playerId, kind: 'BET', amount: '80.00', externalTransactionId: t.external_transaction_id })),
        ),
      );
      expect(again.every((r) => r.body.idempotentReplay === true)).toBe(true);
      expect((await expectConsistent(walletId)).debits).toBe(1);
    }
  });

  test('the same bet sent 50 times in parallel → one debit, 49 replays', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '1000.00');
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '25.00' });
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(pick(i).url, body)));
    expect(responses.filter((r) => r.status === 201).length).toBe(1);
    expect(responses.filter((r) => r.status === 200 && r.body.idempotentReplay).length).toBe(49);
    const ids = new Set(responses.map((r) => r.body.transactionId));
    expect(ids.size).toBe(1);
    expect(responses.every((r) => r.body.balance.amount === '975.00')).toBe(true);
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('975.00');
    expect(state.debits).toBe(1);
  });

  test('the same bet via HTTP ×25 and SQS ×25 concurrently → one debit', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '1000.00');
    const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '10.00' });
    const { idempotencyKey, ...body } = message.data;
    const ackedBefore = await totalAcks();
    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => submit(pick(i).url, body, idempotencyKey)),
      ...Array.from({ length: 25 }, () =>
        // messageIds diferentes: o inbox não ajuda aqui, quem tem que segurar é a idempotency key
        sendToQueue(pick(0).config, pick(0).config.sqs.wagerQueueName, { ...message, messageId: `m-${randomUUID()}` }, walletId),
      ),
    ]);
    // as 25 entregas receberam ack somando os três consumers
    await eventually(totalAcks, (n) => n - ackedBefore >= 25, 20_000);
    expect((await transactionsOf(walletId)).length).toBe(1);
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('990.00');
    expect(state.debits).toBe(1);
  });

  test('heavy contention: 120 bets and 30 wins in parallel never overdraw and stay consistent', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '100.00');
    const requests = [
      ...Array.from({ length: 120 }, () => wagerBody({ walletId, playerId, kind: 'BET', amount: '1.50' })),
      ...Array.from({ length: 30 }, () => wagerBody({ walletId, playerId, kind: 'WIN', amount: '1.00' })),
    ].sort(() => Math.random() - 0.5);
    const responses = await Promise.all(requests.map((body, i) => submit(pick(i).url, body)));
    expect(responses.every((r) => r.status === 201 || r.status === 422)).toBe(true);

    const processedBets = responses.filter((r, i) => r.status === 201 && requests[i]?.kind === 'BET').length;
    const rejected = responses.filter((r) => r.status === 422);
    expect(rejected.every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(processedBets + rejected.length).toBe(120);

    const state = await expectConsistent(walletId);
    const expectedCents = 10_000 + 30 * 100 - processedBets * 150;
    expect(state.balance).toBe((expectedCents / 100).toFixed(2));
    expect(expectedCents).toBeGreaterThanOrEqual(0);
    expect(state.debits).toBe(processedBets);
    expect(state.credits).toBe(31); // abertura + 30 wins
  });
});

describe('independent wallets', () => {
  test('20 wallets × 15 operations in parallel: each wallet exact, no cross-wallet blocking', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => createWallet(pick(i).url, '50.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap(({ walletId, playerId }, w) =>
        Array.from({ length: 15 }, (_, i) =>
          submit(pick(w + i).url, wagerBody({ walletId, playerId, kind: i % 3 === 0 ? 'WIN' : 'BET', amount: '2.00' })),
        ),
      ),
    );
    const elapsed = performance.now() - started;
    for (const { walletId } of wallets) {
      const state = await expectConsistent(walletId);
      expect(state.balance).toBe('40.00'); // 50 + 5 wins × 2 − 10 bets × 2
    }
    expect(elapsed).toBeLessThan(30_000);
  });
});

describe('out-of-order references', () => {
  test('ROLLBACK before its BET → PENDING_REFERENCE, then settles once the BET arrives', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '100.00');
    const bet = wagerBody({ walletId, playerId, kind: 'BET', amount: '40.00', externalTransactionId: `bet-${randomUUID()}` });
    const rollback = wagerBody({ walletId, playerId, kind: 'ROLLBACK', amount: '40.00', referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await submit(pick(0).url, rollback);
    expect(pending.status).toBe(202);
    expect((await submit(pick(1).url, bet)).status).toBe(201);

    await eventually(
      () => http(pick(2).url, 'GET', `/wagering/transactions/${pending.body.transactionId}`),
      (r) => r.body.status === 'PROCESSED',
    );
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('100.00');
    expect(state.debits).toBe(1);
    expect(state.credits).toBe(2);
    const replay = await submit(pick(1).url, rollback);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
  });

  test('REFUND via SQS before its BET via HTTP', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '100.00');
    const betId = `bet-${randomUUID()}`;
    const refund = wagerMessage({ walletId, playerId, kind: 'REFUND', amount: '15.00', referenceExternalTransactionId: betId });
    await sendToQueue(pick(0).config, pick(0).config.sqs.wagerQueueName, refund, walletId);
    await eventually(() => transactionsOf(walletId), (t) => t[0]?.status === 'PENDING_REFERENCE');
    await submit(pick(2).url, wagerBody({ walletId, playerId, kind: 'BET', amount: '15.00', externalTransactionId: betId }));
    await eventually(() => transactionsOf(walletId), (t) => t.length === 2 && t.every((x) => x.status === 'PROCESSED'));
    expect((await expectConsistent(walletId)).balance).toBe('100.00');
  });

  test('ROLLBACK and BET racing (30 pairs fired together) always net to zero', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '100.00');
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const bet = wagerBody({ walletId, playerId, kind: 'BET', amount: '3.00', externalTransactionId: `bet-${randomUUID()}` });
        const rollback = wagerBody({ walletId, playerId, kind: 'ROLLBACK', amount: '3.00', referenceExternalTransactionId: bet.externalTransactionId });
        return Promise.all([submit(pick(i).url, rollback), submit(pick(i + 1).url, bet)]);
      }),
    );
    await eventually(() => transactionsOf(walletId), (t) => t.length === 60 && t.every((x) => x.status === 'PROCESSED'), 20_000);
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('100.00');
    expect(state.debits).toBe(30);
    expect(state.credits).toBe(31);
  });

  test('a reference that never arrives ends REJECTED with REFERENCE_NOT_FOUND and an event', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '100.00');
    const res = await submit(
      pick(0).url,
      wagerBody({ walletId, playerId, kind: 'ROLLBACK', amount: '1.00', referenceExternalTransactionId: `ghost-${randomUUID()}` }),
    );
    expect(res.status).toBe(202);
    const settled = await eventually(
      () => http(pick(1).url, 'GET', `/wagering/transactions/${res.body.transactionId}`),
      (r) => r.body.status !== 'PENDING_REFERENCE',
      15_000,
    );
    expect(settled.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', referenceAttempts: 3 });
    const events = (await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${walletId} ORDER BY occurred_at`) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toContain('WagerTransactionPendingReference');
    expect(events.map((e) => e.event_type)).toContain('WagerTransactionRejected');
    expect((await expectConsistent(walletId)).balance).toBe('100.00');
  });

  test('double reversal attempts in parallel: only one REFUND/ROLLBACK wins', async () => {
    const { walletId, playerId } = await createWallet(pick(0).url, '100.00');
    const bet = wagerBody({ walletId, playerId, kind: 'BET', amount: '20.00', externalTransactionId: `bet-${randomUUID()}` });
    await submit(pick(0).url, bet);
    const reversals = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        submit(
          pick(i).url,
          wagerBody({
            walletId,
            playerId,
            kind: i % 2 ? 'REFUND' : 'ROLLBACK',
            amount: '20.00',
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
    );
    expect(reversals.filter((r) => r.status === 201).length).toBe(1);
    expect(reversals.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toBe(true);
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('100.00');
  });
});
