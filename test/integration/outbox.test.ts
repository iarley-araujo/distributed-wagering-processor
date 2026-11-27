import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../src/config/app-config';
import { Metrics } from '../../src/observability/metrics';
import { ConfigurableFaultInjector } from '../../src/shared/infrastructure/fault-injector';
import { OutboxPublisher } from '../../src/wagering/infrastructure/messaging/outbox-publisher';
import { SqsGateway } from '../../src/wagering/infrastructure/messaging/sqs-gateway';
import { createOrmConfig } from '../../src/wagering/infrastructure/persistence/mikro-orm.config';
import { MikroOrmOutboxRepository } from '../../src/wagering/infrastructure/persistence/repositories';
import {
  createWallet,
  drainQueue,
  ensureSchema,
  setupQueues,
  sql,
  startApp,
  submit,
  TEST_DATABASE_URL,
  testConfig,
  type TestApp,
  uniquePrefix,
  wagerBody,
} from '../support/harness';

/*
 * Os publishers são montados na mão (cada um com o SEU pool de conexões, como instâncias
 * separadas) para o teste controlar exatamente quando cada um faz claim/publica/morre.
 */

let app: TestApp;
let config: AppConfig;
const resources: Array<{ close(): Promise<void> | void }> = [];

function publisher(name: string, overrides: Partial<AppConfig['outbox']> = {}, eventsQueue?: string) {
  const faults = new ConfigurableFaultInjector('');
  const cfg: AppConfig = {
    ...config,
    instanceId: name,
    outbox: { ...config.outbox, ...overrides },
    sqs: { ...config.sqs, eventsQueueName: eventsQueue ?? config.sqs.eventsQueueName },
  };
  const ormPromise = MikroORM.init(createOrmConfig({ url: TEST_DATABASE_URL, poolMin: 0, poolMax: 4 }));
  const sqs = new SqsGateway(cfg);
  return ormPromise.then((orm) => {
    resources.push({ close: () => orm.close(true) }, { close: () => sqs.close() });
    const repo = new MikroOrmOutboxRepository(orm.em.fork());
    return { publisher: new OutboxPublisher(cfg, repo, sqs, new Metrics(), faults, name), faults, repo };
  });
}

async function pendingFor(walletIds: string[]) {
  const rows = (await sql`SELECT id FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)} AND published_at IS NULL`) as unknown[];
  return rows.length;
}

async function outboxIdsFor(walletIds: string[]) {
  return ((await sql`SELECT id FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)} ORDER BY id`) as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

async function publishUntilDone(p: OutboxPublisher, walletIds: string[], deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  while ((await pendingFor(walletIds)) > 0) {
    if (Date.now() > deadline) throw new Error('outbox not drained in time');
    if ((await p.publishOnce()) === 0) await Bun.sleep(50);
  }
}

beforeAll(async () => {
  await ensureSchema();
  config = testConfig(uniquePrefix('outbox'), { APP_ROLES: 'api', OUTBOX_BACKOFF_BASE_MS: '200', OUTBOX_BACKOFF_MAX_MS: '400' });
  await setupQueues(config);
  app = await startApp(config);
  // Drena as linhas que outros arquivos de teste deixaram pendentes, para este arquivo só ver o próprio trabalho.
  const { publisher: flusher } = await publisher('flusher');
  while ((await flusher.publishOnce()) > 0) {}
  await drainQueue(config, config.sqs.eventsQueueName, 1);
});

afterAll(async () => {
  await app?.close();
  for (const r of resources.reverse()) await r.close();
});

describe('transactional outbox', () => {
  test('two concurrent publishers deliver every event, none lost, none claimed twice', async () => {
    const wallets: string[] = [];
    await Promise.all(
      Array.from({ length: 15 }, async () => {
        const { walletId, playerId } = await createWallet(app.url, '100.00');
        wallets.push(walletId);
        await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '10.00' }));
        await submit(app.url, wagerBody({ walletId, playerId, kind: 'WIN', amount: '15.00' }));
      }),
    );
    const expected = await outboxIdsFor(wallets);
    expect(expected.length).toBe(15 * 6);

    const [a, b] = await Promise.all([publisher('pub-a'), publisher('pub-b')]);
    await Promise.all([publishUntilDone(a.publisher, wallets), publishUntilDone(b.publisher, wallets)]);

    const received = (await drainQueue(config, config.sqs.eventsQueueName, 1)).filter((m) => wallets.includes(m.body.aggregateId));
    const eventIds = received.map((m) => m.body.eventId as string);
    expect([...new Set(eventIds)].sort()).toEqual(expected);
    expect(eventIds.length).toBe(expected.length); // SKIP LOCKED + lease: nenhuma linha publicada pelos dois
    for (const m of received) {
      expect(m.attributes.eventType).toBe(m.body.eventType);
      expect(m.body.data.money?.amount ?? m.body.data.balanceAfter?.amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  test('a publisher dying after SQS accepted but before marking: another instance re-publishes the same event ids', async () => {
    const { walletId, playerId } = await createWallet(app.url, '100.00');
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '1.00' }));
    const expected = await outboxIdsFor([walletId]);

    const dying = await publisher('pub-dying', { leaseMs: 500 });
    dying.faults.set('outbox.afterPublishBeforeMark', () => {
      throw new Error('process died');
    });
    await expect(dying.publisher.publishOnce()).rejects.toThrow('process died');
    expect(await pendingFor([walletId])).toBe(expected.length); // commitada, publicada, não marcada

    const survivor = await publisher('pub-survivor');
    await survivor.publisher.publishOnce();
    expect(await pendingFor([walletId])).toBe(expected.length); // lease ainda valendo → ninguém rouba

    await Bun.sleep(600); // a lease expira
    await publishUntilDone(survivor.publisher, [walletId]);

    const received = (await drainQueue(config, config.sqs.eventsQueueName, 1)).filter((m) => m.body.aggregateId === walletId);
    // At-least-once: a segunda publicação pode ser descartada pela deduplicação do SQS FIFO
    // (mesmo MessageDeduplicationId) ou entregue de novo; em qualquer caso tem o mesmo eventId.
    expect([...new Set(received.map((m) => m.body.eventId))].sort()).toEqual(expected);
    const byId = new Map<string, string>();
    for (const m of received) {
      const body = JSON.stringify(m.body);
      expect(byId.get(m.body.eventId) ?? body).toBe(body);
      byId.set(m.body.eventId, body);
    }
  });

  test('publish failures are retried with backoff and recorded on the row', async () => {
    const { walletId, playerId } = await createWallet(app.url, '100.00');
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '2.00' }));
    const broken = await publisher('pub-broken', {}, `${uniquePrefix('missing')}.fifo`);
    await broken.publisher.publishOnce();

    const rows = (await sql`SELECT attempts, last_error, next_attempt_at > now() AS deferred, lease_owner
                              FROM outbox_messages WHERE aggregate_id = ${walletId}`) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row).toMatchObject({ attempts: 1, deferred: true, lease_owner: null });
      expect(String(row.last_error)).not.toBe('');
    }

    const healthy = await publisher('pub-healthy');
    await publishUntilDone(healthy.publisher, [walletId]);
    const published = (await sql`SELECT attempts FROM outbox_messages WHERE aggregate_id = ${walletId}`) as Array<{ attempts: number }>;
    expect(published.every((r) => r.attempts === 2)).toBe(true);
    await drainQueue(config, config.sqs.eventsQueueName, 1);
  });

  test('graceful stop releases leases so another instance can take over immediately', async () => {
    const { walletId, playerId } = await createWallet(app.url, '100.00');
    await submit(app.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '3.00' }));
    const first = await publisher('pub-stopping', { leaseMs: 60_000 });
    // faz o claim sem publicar e depois para
    await first.repo.claimDue('pub-stopping', 60_000, 100);
    await first.publisher.stop();
    const leased = (await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE lease_owner = 'pub-stopping'`) as Array<{ n: number }>;
    expect(leased[0]?.n).toBe(0);
    const next = await publisher('pub-next');
    await publishUntilDone(next.publisher, [walletId], 5_000);
  });
});
