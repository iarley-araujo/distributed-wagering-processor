import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ConfigurableFaultInjector } from '../../src/shared/infrastructure/fault-injector';
import { TransientInfrastructureError } from '../../src/wagering/application/errors';
import {
  createWallet,
  drainQueue,
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
 * Consumer contra um endpoint SQS real e PostgreSQL real. Cada bloco describe tem as
 * próprias filas, assim as asserções sobre o conteúdo das filas não se misturam com outros testes.
 */

beforeAll(ensureSchema);

async function consumerApp(name: string, extra: Record<string, string> = {}, faults = new ConfigurableFaultInjector('')) {
  const config = testConfig(uniquePrefix(name), { APP_ROLES: 'api,consumer', ...extra });
  await setupQueues(config);
  const app = await startApp(config, { faultInjector: faults });
  return { app, config, faults };
}

const metric = async (app: TestApp, pattern: RegExp) => {
  const text = await (await fetch(`${app.url}/metrics`)).text();
  return Number(text.match(pattern)?.[1] ?? 0);
};

const inboxCount = async (messageId: string) =>
  ((await sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`) as Array<{ n: number }>)[0]?.n;

describe('inbox and redelivery', () => {
  let ctx: Awaited<ReturnType<typeof consumerApp>>;
  beforeAll(async () => {
    ctx = await consumerApp('inbox');
  });
  afterAll(() => ctx.app.close());

  test('processes a message and acks it only after commit', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '25.00' });
    await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, message, walletId);
    await eventually(() => transactionsOf(walletId), (txs) => txs.length === 1 && txs[0]?.status === 'PROCESSED');
    expect(await inboxCount(message.messageId)).toBe(1);
    expect((await expectConsistent(walletId)).balance).toBe('75.00');
  });

  test('the same message delivered 5 times produces one effect (persistent inbox)', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '10.00' });
    for (let i = 0; i < 5; i++) await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, message, walletId);
    await eventually(() => metric(ctx.app, /wagering_consumer_messages_total\{outcome="ack"\} (\d+)/), (n) => n >= 6);
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('90.00');
    expect(state.debits).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await metric(ctx.app, /wagering_duplicates_detected_total\{mechanism="inbox"\} (\d+)/)).toBeGreaterThanOrEqual(4);
  });

  test('a new message with an already-used idempotency key is an idempotent replay (no double debit)', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    const body = wagerBody({ walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: `x-${randomUUID()}` });
    await submit(ctx.app.url, body);
    await sendToQueue(
      ctx.config,
      ctx.config.sqs.wagerQueueName,
      wagerMessage({ walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: body.externalTransactionId }),
      walletId,
    );
    await eventually(() => metric(ctx.app, /wagering_duplicates_detected_total\{mechanism="idempotency_key"\} (\d+)/), (n) => n >= 1);
    expect((await expectConsistent(walletId)).debits).toBe(1);
  });

  test('business rejection is terminal and acked', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '5.00');
    await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, wagerMessage({ walletId, playerId, kind: 'BET', amount: '50.00' }), walletId);
    const txs = await eventually(() => transactionsOf(walletId), (t) => t.length === 1);
    expect(txs[0]).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('redelivery after a failure between commit and ack does not duplicate effects', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    let failures = 0;
    ctx.faults.set('consumer.afterCommitBeforeAck', () => {
      if (failures++ === 0) throw new Error('worker died before ack');
    });
    try {
      const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '30.00' });
      await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, message, walletId);
      // a primeira entrega commita e falha antes do ack; é reentregue depois do visibility timeout (5s)
      const duplicatesBefore = await metric(ctx.app, /wagering_duplicates_detected_total\{mechanism="inbox"\} (\d+)/);
      await eventually(async () => failures, (n) => n >= 2, 20_000);
      await eventually(
        () => metric(ctx.app, /wagering_duplicates_detected_total\{mechanism="inbox"\} (\d+)/),
        (n) => n > duplicatesBefore,
      );
      const state = await expectConsistent(walletId);
      expect(state.balance).toBe('70.00');
      expect(state.debits).toBe(1);
    } finally {
      ctx.faults.set('consumer.afterCommitBeforeAck', undefined);
    }
  });
});

describe('retry, DLQ and FAILED', () => {
  let ctx: Awaited<ReturnType<typeof consumerApp>>;
  beforeAll(async () => {
    ctx = await consumerApp('retry', { CONSUMER_MAX_ATTEMPTS: '3' });
  });
  afterAll(() => ctx.app.close());

  test('malformed messages go to the DLQ immediately', async () => {
    await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, '{"not": "a wager"}', 'g-1');
    await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, 'not even json', 'g-2');
    const dead: Awaited<ReturnType<typeof drainQueue>> = [];
    await eventually(
      async () => dead.push(...(await drainQueue(ctx.config, ctx.config.sqs.wagerDlqName, 1))),
      () => dead.length >= 2,
      20_000,
    );
    expect(dead.map((d) => d.attributes.failureReason)).toEqual(['MALFORMED_MESSAGE', 'MALFORMED_MESSAGE']);
    expect(await metric(ctx.app, /wagering_dlq_messages_total\{reason="MALFORMED_MESSAGE"\} (\d+)/)).toBe(2);
  });

  test('a reused messageId with a different body is a permanent error (DLQ)', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    const original = wagerMessage({ walletId, playerId, kind: 'BET', amount: '1.00' });
    await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, original, walletId);
    await eventually(() => transactionsOf(walletId), (t) => t.length === 1);
    const tampered = { ...original, data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } } };
    await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, tampered, walletId);
    const dead = await eventually(() => drainQueue(ctx.config, ctx.config.sqs.wagerDlqName, 1), (m) => m.length >= 1, 20_000);
    expect(dead[0]?.attributes.failureReason).toBe('INBOX_PAYLOAD_MISMATCH');
    expect((await expectConsistent(walletId)).balance).toBe('99.00');
  });

  test('transient failures are retried with backoff and then succeed exactly once', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    let attempts = 0;
    ctx.faults.set('process.beforeCommit', () => {
      if (attempts++ < 2) throw new TransientInfrastructureError('db blip', 'injected');
    });
    try {
      await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, wagerMessage({ walletId, playerId, kind: 'BET', amount: '40.00' }), walletId);
      await eventually(() => transactionsOf(walletId), (t) => t.length === 1 && t[0]?.status === 'PROCESSED', 20_000);
      expect(attempts).toBe(3);
      const state = await expectConsistent(walletId);
      expect(state.balance).toBe('60.00');
      expect(state.debits).toBe(1);
      expect(await metric(ctx.app, /wagering_retries_total\{component="consumer",reason="TRANSIENT_FAILURE"\} (\d+)/)).toBeGreaterThanOrEqual(2);
    } finally {
      ctx.faults.set('process.beforeCommit', undefined);
    }
  });

  test('after the attempt limit the message is dead-lettered and recorded as FAILED', async () => {
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    ctx.faults.set('process.beforeCommit', () => {
      throw new Error('persistent unknown failure');
    });
    const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '40.00' });
    try {
      await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, message, walletId);
      const dead = await eventually(() => drainQueue(ctx.config, ctx.config.sqs.wagerDlqName, 1), (m) => m.length >= 1, 30_000);
      expect(dead[0]?.attributes).toMatchObject({ failureReason: 'RETRIES_EXHAUSTED', receiveCount: '3' });
      expect(dead[0]?.body.messageId).toBe(message.messageId);
    } finally {
      ctx.faults.set('process.beforeCommit', undefined);
    }
    const txs = await transactionsOf(walletId);
    expect(txs).toEqual([
      expect.objectContaining({ status: 'FAILED', failure_code: 'PROCESSING_RETRIES_EXHAUSTED' }),
    ]);
    expect((await expectConsistent(walletId)).balance).toBe('100.00');
    // terminal: o retry HTTP do provedor com a mesma key recebe o desfecho registrado
    const { idempotencyKey, ...data } = message.data;
    const replay = await submit(ctx.app.url, data, idempotencyKey);
    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({ status: 'FAILED', failureCode: 'PROCESSING_RETRIES_EXHAUSTED', idempotentReplay: true });
    const events = await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${walletId} AND event_type = 'WagerTransactionFailed'`;
    expect(events.length).toBe(1);
  });
});

describe('graceful shutdown', () => {
  test('finishes in-flight messages and returns not-started ones to the queue', async () => {
    const faults = new ConfigurableFaultInjector('');
    const ctx = await consumerApp('shutdown', { CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '60' }, faults);
    const { walletId, playerId } = await createWallet(ctx.app.url, '100.00');
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    let slowOnce = true;
    faults.set('process.beforeCommit', async () => {
      if (!slowOnce) return;
      slowOnce = false;
      entered();
      await Bun.sleep(1_500);
    });

    // três mensagens do mesmo grupo: chegam num lote só e são processadas em sequência
    const messages = ['1.00', '2.00', '3.00'].map((amount) => wagerMessage({ walletId, playerId, kind: 'BET', amount }));
    for (const m of messages) await sendToQueue(ctx.config, ctx.config.sqs.wagerQueueName, m, walletId);
    await inFlight;
    const started = Date.now();
    await ctx.app.close();
    expect(Date.now() - started).toBeLessThan(5_000);

    // a mensagem em andamento foi commitada e recebeu ack
    const afterShutdown = await transactionsOf(walletId);
    expect(afterShutdown.filter((t) => t.status === 'PROCESSED').length).toBeGreaterThanOrEqual(1);

    // o resto volta na hora (visibilidade 0), bem antes do visibility timeout de 60s
    const next = await startApp(ctx.config);
    try {
      await eventually(() => transactionsOf(walletId), (t) => t.length === 3, 10_000);
      const state = await expectConsistent(walletId);
      expect(state.balance).toBe('94.00');
      expect(state.debits).toBe(3);
    } finally {
      await next.close();
    }
    const ready = await http(next.url, 'GET', '/health/live').catch(() => ({ status: 0 }));
    expect(ready.status).toBe(0);
  });
});
