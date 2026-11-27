import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createWallet,
  ensureSchema,
  expectConsistent,
  http,
  setupQueues,
  sql,
  startApp,
  submit,
  testConfig,
  type TestApp,
  uniquePrefix,
  wagerBody,
} from '../support/harness';

let app: TestApp;

beforeAll(async () => {
  await ensureSchema();
  const config = testConfig(uniquePrefix('http'), { APP_ROLES: 'api,pending-references' });
  await setupQueues(config);
  app = await startApp(config);
});

afterAll(async () => {
  await app?.close();
});

describe('POST /wallets', () => {
  test('creates a wallet with an OPENING credit in the same transaction', async () => {
    const playerId = randomUUID();
    const res = await http(app.url, 'POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const rows = await sql`SELECT kind, status FROM wager_transactions WHERE wallet_id = ${res.body.id}`;
    expect(rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED' }]);
    const state = await expectConsistent(res.body.id);
    expect(state.entries).toBe(1);
  });

  test('zero initial balance creates no ledger entry', async () => {
    const { walletId } = await createWallet(app.url, '0.00');
    const state = await expectConsistent(walletId);
    expect(state.entries).toBe(0);
  });

  test('duplicate (playerId, currency) is a 409 conflict', async () => {
    const { playerId } = await createWallet(app.url, '1.00');
    const res = await http(app.url, 'POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    const other = await http(app.url, 'POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'USD' } });
    expect(other.status).toBe(201);
  });

  test.each([
    [{ playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    [{ playerId: randomUUID(), initialBalance: { amount: 1, currency: 'BRL' } }],
    [{ playerId: randomUUID(), initialBalance: { amount: '-1.00', currency: 'BRL' } }],
    [{ playerId: randomUUID(), initialBalance: { amount: '1.001', currency: 'BRL' } }],
  ])('invalid body → 400 VALIDATION_ERROR (%#)', async (body) => {
    const res = await http(app.url, 'POST', '/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /wagering/transactions', () => {
  test('processes, replays with the original result, and refuses a divergent payload', async () => {
    const { walletId, playerId } = await createWallet(app.url, '1000.00');
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '25.00' });
    const first = await submit(app.url, body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    // o saldo muda depois; o replay ainda tem que devolver o saldo observado naquela hora
    expect((await submit(app.url, wagerBody({ walletId, playerId, kind: 'WIN', amount: '100.00' }))).status).toBe(201);

    const replay = await submit(app.url, { ...body });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await submit(app.url, { ...body, money: { amount: '26.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(conflict.body.error.details.existingTransactionId).toBe(first.body.transactionId);

    const reusedExternalId = await submit(app.url, body, 'another-key');
    expect(reusedExternalId.status).toBe(409);
    expect(reusedExternalId.body.error.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');

    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('1075.00');
    expect(state.debits).toBe(1);
  });

  test('business rejection is 422 with a failureCode, and its replay is identical', async () => {
    const { walletId, playerId } = await createWallet(app.url, '10.00');
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '10.01' });
    const res = await submit(app.url, body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const replay = await submit(app.url, body);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
    const state = await expectConsistent(walletId);
    expect(state.entries).toBe(1); // só o crédito de abertura
  });

  test('currency mismatch and foreign player are rejected (auditable, no ledger entry)', async () => {
    const { walletId, playerId } = await createWallet(app.url, '10.00');
    const usd = await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '1.00', currency: 'USD' }));
    expect(usd.status).toBe(422);
    expect(usd.body.failureCode).toBe('CURRENCY_MISMATCH');
    const foreign = await submit(app.url, wagerBody({ walletId, playerId: randomUUID(), kind: 'BET', amount: '1.00' }));
    expect(foreign.status).toBe(422);
    expect(foreign.body.failureCode).toBe('PLAYER_WALLET_MISMATCH');
    await expectConsistent(walletId);
  });

  test('LOSS is processed without moving the balance', async () => {
    const { walletId, playerId } = await createWallet(app.url, '10.00');
    const res = await submit(app.url, wagerBody({ walletId, playerId, kind: 'LOSS', amount: '5.00' }));
    expect(res.status).toBe(201);
    expect(res.body.balance.amount).toBe('10.00');
    expect((await expectConsistent(walletId)).version).toBe(1);
  });

  test('reference not yet received → 202 PENDING_REFERENCE', async () => {
    const { walletId, playerId } = await createWallet(app.url, '10.00');
    const res = await submit(
      app.url,
      wagerBody({ walletId, playerId, kind: 'ROLLBACK', amount: '5.00', referenceExternalTransactionId: `missing-${randomUUID()}` }),
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('unknown wallet → 404; malformed → 400; missing key → 400', async () => {
    const missing = await submit(app.url, wagerBody({ walletId: randomUUID(), playerId: randomUUID(), kind: 'BET', amount: '1.00' }));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');

    const { walletId, playerId } = await createWallet(app.url, '10.00');
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '1.00' });
    expect((await http(app.url, 'POST', '/wagering/transactions', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    for (const bad of [
      { ...body, kind: 'OPENING' },
      { ...body, money: { amount: '1e2', currency: 'BRL' } },
      { ...body, money: { amount: 'NaN', currency: 'BRL' } },
      { ...body, kind: 'REFUND' },
      '{"not json',
    ]) {
      const res = await http(app.url, 'POST', '/wagering/transactions', bad, { 'idempotency-key': randomUUID() });
      expect(res.status).toBe(400);
      expect(res.body.error.retryable).toBe(false);
    }
    expect((await expectConsistent(walletId)).version).toBe(1);
  });
});

describe('queries', () => {
  test('GET wallet, transaction by id and by provider external id', async () => {
    const { walletId, playerId } = await createWallet(app.url, '50.00');
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '20.00' });
    const created = await submit(app.url, body);

    const wallet = await http(app.url, 'GET', `/wallets/${walletId}`);
    expect(wallet.status).toBe(200);
    expect(wallet.body).toMatchObject({ id: walletId, balance: { amount: '30.00', currency: 'BRL' }, version: 2 });

    const byId = await http(app.url, 'GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '20.00', currency: 'BRL' } });
    const byExternal = await http(app.url, 'GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.body.id).toBe(created.body.transactionId);

    expect((await http(app.url, 'GET', `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await http(app.url, 'GET', `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await http(app.url, 'GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  test('ledger pagination with a stable opaque cursor', async () => {
    const { walletId, playerId } = await createWallet(app.url, '100.00');
    for (let i = 0; i < 7; i++) await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '1.00' }));

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=3&cursor=${cursor}` : '?limit=3';
      const page = await http(app.url, 'GET', `/wallets/${walletId}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = page.body.nextCursor;
      // lançamentos novos entrando durante a paginação não podem deslocar as páginas
      if (seen.length === 3) await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '1.00' }));
    } while (cursor);
    expect(seen).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);

    const foreignCursor = await http(app.url, 'GET', `/wallets/${randomUUID()}/ledger?cursor=${'x'.repeat(10)}`);
    expect(foreignCursor.status).toBe(400);
  });

  test('reconciliation reports consistency', async () => {
    const { walletId, playerId } = await createWallet(app.url, '975.00');
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '0.10' }));
    const res = await http(app.url, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId,
      storedBalance: { amount: '974.90', currency: 'BRL' },
      calculatedBalance: { amount: '974.90', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('reconciliation flags (and does not fix) a divergence', async () => {
    const { walletId } = await createWallet(app.url, '10.00');
    // Simula uma corrupção que passa por fora da aplicação E dos triggers de integridade
    // (replication role, só superuser) para provar que divergência é reportada, não escondida.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 11.00, version = 2 WHERE id = ${walletId}`;
    });
    const res = await http(app.url, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: '1.00', currency: 'BRL' } });
    const [after] = (await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`) as Array<{ balance: string }>;
    expect(after?.balance).toBe('11.00');
    const metrics = await (await fetch(`${app.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_reconciliation_divergences_total [1-9]/);
  });
});

describe('health and metrics (no auth)', () => {
  test('liveness and readiness', async () => {
    expect((await http(app.url, 'GET', '/health/live')).status).toBe(200);
    const ready = await http(app.url, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.map((c: { name: string; status: string }) => `${c.name}:${c.status}`)).toEqual([
      'postgres:up',
      'sqs:up',
    ]);
  });

  test('metrics exposes the business counters', async () => {
    const text = await (await fetch(`${app.url}/metrics`)).text();
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_wallet_lock_wait_seconds',
      'wagering_processing_duration_seconds',
      'wagering_outbox_lag_seconds',
      'wagering_dlq_messages_total',
      'wagering_lock_conflicts_total',
      'wagering_retries_total',
    ]) {
      expect(text).toContain(name);
    }
  });

  test('responses carry a correlation id', async () => {
    const res = await http(app.url, 'GET', '/health/live', undefined, { 'x-correlation-id': 'corr-test-1' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-test-1');
  });
});
