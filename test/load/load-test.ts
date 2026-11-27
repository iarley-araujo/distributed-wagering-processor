/**
 * Teste de carga — `bun run test:load`
 *
 * Metodologia
 *  - Closed-loop: LOAD_CONCURRENCY usuários virtuais, cada um manda uma requisição, espera a
 *    resposta e manda a próxima, por LOAD_DURATION_S segundos (latência = ida e volta HTTP completa).
 *  - LOAD_WALLETS wallets; LOAD_HOT_SHARE de todas as operações vão para UMA hot wallet
 *    (pior caso para um lock por wallet); o resto se espalha de forma uniforme.
 *  - Mix: 70% BET, 18% WIN, 5% LOSS, 7% ROLLBACK de uma bet anterior do mesmo usuário;
 *    LOAD_DUPLICATE_RATE das requisições são reenvios idênticos de uma anterior (retry do provedor).
 *  - Round-robin nas LOAD_BASE_URLS; se não vier nenhuma, sobe LOAD_INSTANCES processos
 *    da aplicação localmente (precisa de PostgreSQL + SQS, igual à suíte de testes).
 *  - Depois da carga: tempo de drenagem do outbox, contadores Prometheus somados das instâncias e
 *    reconciliação de TODAS as wallets (saldo gravado × ledger) — a execução falha se alguma divergir.
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { createOrmConfig } from '../../src/wagering/infrastructure/persistence/mikro-orm.config';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, type } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupQueues, testConfig, testEnv, uniquePrefix } from '../support/harness';
import { type Instance, spawnInstance } from '../support/instances';

const env = process.env;
const DURATION_S = Number(env.LOAD_DURATION_S ?? 30);
const CONCURRENCY = Number(env.LOAD_CONCURRENCY ?? 64);
const WALLETS = Number(env.LOAD_WALLETS ?? 50);
const HOT_SHARE = Number(env.LOAD_HOT_SHARE ?? 0.2);
const DUPLICATE_RATE = Number(env.LOAD_DUPLICATE_RATE ?? 0.1);
const INSTANCES = Number(env.LOAD_INSTANCES ?? 3);
// Quando sobe as próprias instâncias, usa um banco dedicado para o backlog (grande) do outbox
// nunca vazar para o banco da suíte de testes.
const DATABASE_URL =
  env.LOAD_DATABASE_URL ??
  (env.TEST_DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering_test').replace(
    /\/[^/?]+(\?|$)/,
    '/wagering_load$1',
  );

type Kind = 'BET' | 'WIN' | 'LOSS' | 'ROLLBACK';
interface Sent {
  body: Record<string, unknown>;
  key: string;
}

/** Cria o banco de carga se precisar e aplica as migrations. */
async function prepareDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const admin = new SQL(url.replace(/\/[^/?]+(\?|$)/, '/postgres$1'), { max: 1 });
  const exists = (await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`) as unknown[];
  if (exists.length === 0) await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.close();
  const orm = await MikroORM.init(createOrmConfig({ url, poolMin: 0, poolMax: 2 }));
  await orm.getMigrator().up();
  await orm.close(true);
}

const spawned: Instance[] = [];
let eventsQueuePrefix: string | undefined;
let baseUrls = (env.LOAD_BASE_URLS ?? '').split(',').filter(Boolean);
if (baseUrls.length === 0) {
  await prepareDatabase(DATABASE_URL);
  const prefix = uniquePrefix('load');
  eventsQueuePrefix = prefix;
  await setupQueues(testConfig(prefix));
  const instanceEnv = {
    ...testEnv(prefix),
    DATABASE_URL,
    LOG_LEVEL: 'warn',
    CONSUMER_WAIT_TIME_SECONDS: '10',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REF_POLL_INTERVAL_MS: '500',
    DB_POOL_MAX: String(Math.max(10, Math.ceil(CONCURRENCY / INSTANCES) + 5)),
  };
  for (let i = 0; i < INSTANCES; i++) spawned.push(await spawnInstance(`load-${i + 1}`, instanceEnv));
  baseUrls = spawned.map((s) => s.url);
}

const sql = new SQL(DATABASE_URL, { max: 4 });
const url = (i: number) => baseUrls[i % baseUrls.length] as string;

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, ms: performance.now() - started };
  } catch {
    return { status: 0, json: {}, ms: performance.now() - started };
  }
}

async function scrape(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const base of baseUrls) {
    const text = await (await fetch(`${base}/metrics`)).text();
    for (const line of text.split('\n')) {
      const m = /^(wagering_[a-z_]+(?:\{[^}]*\})?) ([0-9.e+-]+)$/.exec(line);
      if (m?.[1] && m[2]) totals[m[1]] = (totals[m[1]] ?? 0) + Number(m[2]);
    }
  }
  return totals;
}

const sum = (metrics: Record<string, number>, prefix: string) =>
  Object.entries(metrics)
    .filter(([k]) => k.startsWith(prefix))
    .reduce((acc, [, v]) => acc + v, 0);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

// ---- preparação ---------------------------------------------------------------
const wallets: Array<{ walletId: string; playerId: string }> = [];
for (let i = 0; i < WALLETS; i++) {
  const playerId = randomUUID();
  const res = await post(url(i), '/wallets', { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.json)}`);
  wallets.push({ walletId: String(res.json.id), playerId });
}
const hot = wallets[0] as { walletId: string; playerId: string };

const latencies: number[] = [];
const statuses = new Map<number, number>();
let duplicatesSent = 0;
let maxOutboxLag = 0;
const deadline = Date.now() + DURATION_S * 1000;

// Lag do outbox DESTA execução = idade do evento não publicado mais antigo, amostrada a cada segundo.
const lagSampler = setInterval(async () => {
  try {
    const [row] = (await sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0)::float8 AS lag
        FROM outbox_messages WHERE aggregate_id IN ${sql(wallets.map((w) => w.walletId))} AND published_at IS NULL`) as Array<{ lag: number }>;
    maxOutboxLag = Math.max(maxOutboxLag, Number(row?.lag ?? 0));
  } catch {
    // ignora erro de amostragem
  }
}, 1000);

// Um consumidor dos eventos de integração, como em produção: mantém a fila de eventos
// rasa e confere que duplicatas (se houver) têm o mesmo eventId.
const eventIdsSeen = new Set<string>();
let eventDeliveries = 0;
let consumingEvents = true;
const eventsConsumer = (async () => {
  if (spawned.length === 0) return; // deploy externo: os consumidores de lá cuidam dos eventos
  const { SqsGateway } = await import('../../src/wagering/infrastructure/messaging/sqs-gateway');
  const config = testConfig(eventsQueuePrefix as string);
  const gateway = new SqsGateway(config);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (consumingEvents) {
        const messages = await gateway
          .receive(config.sqs.eventsQueueName, { max: 10, waitSeconds: 1, visibilitySeconds: 30 })
          .catch(() => []);
        for (const m of messages) {
          eventDeliveries++;
          eventIdsSeen.add(String(JSON.parse(m.Body ?? '{}').eventId));
          if (m.ReceiptHandle) await gateway.delete(config.sqs.eventsQueueName, m.ReceiptHandle).catch(() => undefined);
        }
      }
    }),
  );
  gateway.close();
})();

const metricsBefore = await scrape();
const startedAt = performance.now();

interface PlacedBet {
  externalTransactionId: string;
  wallet: (typeof wallets)[number];
  amount: string;
  roundId: string;
}

async function virtualUser(user: number): Promise<void> {
  const history: Sent[] = [];
  const myBets: PlacedBet[] = [];
  let n = 0;
  while (Date.now() < deadline) {
    n++;
    let sent: Sent;
    if (history.length > 0 && Math.random() < DUPLICATE_RATE) {
      sent = history[Math.floor(Math.random() * history.length)] as Sent;
      duplicatesSent++;
    } else {
      const r = Math.random();
      let kind: Kind = r < 0.7 ? 'BET' : r < 0.88 ? 'WIN' : r < 0.93 ? 'LOSS' : 'ROLLBACK';
      const target = kind === 'ROLLBACK' ? myBets.shift() : undefined;
      if (kind === 'ROLLBACK' && !target) kind = 'BET';
      const wallet =
        target?.wallet ?? (Math.random() < HOT_SHARE ? hot : (wallets[Math.floor(Math.random() * wallets.length)] as typeof hot));
      const externalTransactionId = `load-${user}-${n}-${randomUUID().slice(0, 8)}`;
      const amount = target?.amount ?? `${1 + Math.floor(Math.random() * 20)}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
      const roundId = target?.roundId ?? `round-${user}-${Math.floor(n / 4)}`;
      const body: Record<string, unknown> = {
        providerId: 'load-provider',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId,
        gameId: 'load-game',
        kind,
        money: { amount, currency: 'BRL' },
        ...(target ? { referenceExternalTransactionId: target.externalTransactionId } : {}),
      };
      if (kind === 'BET') myBets.push({ externalTransactionId, wallet, amount, roundId });
      sent = { body, key: `load-provider:${externalTransactionId}` };
      history.push(sent);
      if (history.length > 50) history.shift();
    }
    const res = await post(url(user + n), '/wagering/transactions', sent.body, { 'idempotency-key': sent.key });
    latencies.push(res.ms);
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => virtualUser(i)));
const elapsedS = (performance.now() - startedAt) / 1000;
clearInterval(lagSampler);

// ---- drenagem e verificação ----------------------------------------------------
const walletIds = wallets.map((w) => w.walletId);
const drainStarted = performance.now();
for (;;) {
  const [row] = (await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)} AND published_at IS NULL`) as Array<{ n: number }>;
  if ((row?.n ?? 0) === 0 || performance.now() - drainStarted > 120_000) break;
  await Bun.sleep(250);
}
const drainS = (performance.now() - drainStarted) / 1000;
await Bun.sleep(2_000);
consumingEvents = false;
await eventsConsumer;
const [ourEvents] = (await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)}`) as Array<{ n: number }>;
const [pendingRefs] = (await sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id IN ${sql(walletIds)} AND status = 'PENDING_REFERENCE'`) as Array<{ n: number }>;

let inconsistent = 0;
for (const [i, w] of wallets.entries()) {
  const rec = await post(url(i), `/wallets/${w.walletId}/reconciliation`, {});
  if (rec.json.consistent !== true) inconsistent++;
}
const [{ version: pgVersion } = { version: '?' }] = (await sql`SELECT version()`) as Array<{ version: string }>;
const metricsAfter = await scrape();
const delta = (prefix: string) => sum(metricsAfter, prefix) - sum(metricsBefore, prefix);

const sorted = [...latencies].sort((a, b) => a - b);
const total = latencies.length;
const errors = (statuses.get(0) ?? 0) + [...statuses.entries()].filter(([s]) => s >= 500).reduce((a, [, c]) => a + c, 0);
const lockWaitCount = delta('wagering_wallet_lock_wait_seconds_count');
const lockWaitSum = delta('wagering_wallet_lock_wait_seconds_sum');

const report = {
  environment: {
    os: type(),
    cpus: `${cpus().length}× ${cpus()[0]?.model ?? '?'}`,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    bun: Bun.version,
    postgres: pgVersion.split(' ').slice(0, 2).join(' '),
    sqsEndpoint: env.AWS_ENDPOINT_URL ?? 'default',
    instances: baseUrls.length,
  },
  parameters: { durationS: DURATION_S, concurrency: CONCURRENCY, wallets: WALLETS, hotShare: HOT_SHARE, duplicateRate: DUPLICATE_RATE },
  results: {
    requests: total,
    throughputRps: Math.round(total / elapsedS),
    latencyMs: {
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      p99: Number(percentile(sorted, 99).toFixed(1)),
      max: Number((sorted.at(-1) ?? 0).toFixed(1)),
    },
    statusCodes: Object.fromEntries([...statuses.entries()].sort()),
    errorRate: Number((errors / Math.max(1, total)).toFixed(4)),
    duplicatesSent,
    duplicatesDetected: delta('wagering_duplicates_detected_total'),
    lockConflicts: delta('wagering_lock_conflicts_total'),
    meanWalletLockWaitMs: lockWaitCount ? Number(((lockWaitSum / lockWaitCount) * 1000).toFixed(2)) : 0,
    maxOutboxLagS: Number(maxOutboxLag.toFixed(2)),
    outboxDrainAfterLoadS: Number(drainS.toFixed(2)),
    eventsCommitted: ourEvents?.n ?? 0,
    eventDeliveriesReceived: eventDeliveries,
    distinctEventIdsReceived: eventIdsSeen.size,
    pendingReferencesLeft: pendingRefs?.n ?? 0,
    walletsReconciled: wallets.length,
    walletsInconsistent: inconsistent,
  },
};

console.log(JSON.stringify(report, null, 2));
const dir = join(import.meta.dir, 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));

await sql.close();
for (const s of spawned) await s.stop('SIGTERM');
if (inconsistent > 0) {
  console.error(`FAIL: ${inconsistent} wallet(s) diverged from their ledger`);
  process.exit(1);
}
