import { PurgeQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AppOverrides } from '../../src/app.module';
import { createApp } from '../../src/bootstrap';
import { type AppConfig, loadConfig } from '../../src/config/app-config';
import { SqsGateway } from '../../src/wagering/infrastructure/messaging/sqs-gateway';
import { createOrmConfig } from '../../src/wagering/infrastructure/persistence/mikro-orm.config';
import { createQueues } from '../../scripts/create-queues';

/*
 * Harness de integração: PostgreSQL DE VERDADE e SQS DE VERDADE (LocalStack/MiniStack no compose,
 * qualquer endpoint compatível com SQS localmente). Nada é mockado. Cada arquivo de teste tem os
 * próprios nomes de fila; as linhas do banco ficam isoladas usando wallets/players novos em cada teste.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering_test';
export const SQS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

export const sql = new SQL(TEST_DATABASE_URL, { max: 10 });

export function testEnv(prefix: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    AWS_ENDPOINT_URL: SQS_ENDPOINT,
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAGER_QUEUE: `${prefix}-wager-transactions.fifo`,
    SQS_WAGER_DLQ: `${prefix}-wager-transactions-dlq.fifo`,
    SQS_EVENTS_QUEUE: `${prefix}-wagering-events.fifo`,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'error',
    CONSUMER_WAIT_TIME_SECONDS: '1',
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
    CONSUMER_BACKOFF_BASE_MS: '200',
    CONSUMER_BACKOFF_MAX_MS: '1000',
    SHUTDOWN_GRACE_MS: '5000',
    OUTBOX_POLL_INTERVAL_MS: '50',
    PENDING_REF_POLL_INTERVAL_MS: '100',
    PENDING_REF_BACKOFF_BASE_MS: '200',
    PENDING_REF_BACKOFF_MAX_MS: '400',
    DB_POOL_MAX: '20',
    ...extra,
  };
}

export function testConfig(prefix: string, extra: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...process.env, ...testEnv(prefix, extra) });
}

export function uniquePrefix(name: string): string {
  return `t-${name}-${randomUUID().slice(0, 8)}`;
}

let migrated: Promise<void> | undefined;
/** Aplica as migrations no banco de testes uma vez por processo (idempotente). */
export function ensureSchema(): Promise<void> {
  migrated ??= (async () => {
    const orm = await MikroORM.init(createOrmConfig({ url: TEST_DATABASE_URL, poolMin: 0, poolMax: 2 }));
    try {
      await orm.getMigrator().up();
    } finally {
      await orm.close(true);
    }
  })();
  return migrated;
}

export async function setupQueues(config: AppConfig): Promise<void> {
  await createQueues(config);
}

export async function purgeQueue(config: AppConfig, queueName: string): Promise<void> {
  const sqs = new SqsGateway(config);
  try {
    await sqs.client.send(new PurgeQueueCommand({ QueueUrl: await sqs.queueUrl(queueName) }));
  } finally {
    sqs.close();
  }
}

export interface TestApp {
  app: INestApplication;
  url: string;
  config: AppConfig;
  close(): Promise<void>;
}

export async function startApp(config: AppConfig, overrides: AppOverrides = {}): Promise<TestApp> {
  const app = await createApp(config, overrides);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    config,
    close: () => app.close(),
  };
}

// ---- helpers HTTP ----------------------------------------------------------

export async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // mantém o texto
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export async function createWallet(base: string, amount: string, currency = 'BRL', playerId = randomUUID()) {
  const res = await http(base, 'POST', '/wallets', { playerId, initialBalance: { amount, currency } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  amount: string;
  externalTransactionId?: string;
  providerId?: string;
  roundId?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}

export function wagerBody(input: WagerInput) {
  return {
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId ?? `tx-${randomUUID()}`,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: input.kind,
    money: { amount: input.amount, currency: input.currency ?? 'BRL' },
    ...(input.referenceExternalTransactionId
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  };
}

export function submit(base: string, body: ReturnType<typeof wagerBody>, idempotencyKey?: string) {
  return http(base, 'POST', '/wagering/transactions', body, {
    'idempotency-key': idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
  });
}

// ---- helpers SQS -----------------------------------------------------------

export function wagerMessage(input: WagerInput & { messageId?: string; idempotencyKey?: string }) {
  const data = wagerBody(input);
  return {
    messageId: input.messageId ?? `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested' as const,
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: input.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}` },
  };
}

/**
 * Manda a mensagem com um deduplication id aleatório, para que mandar o mesmo envelope
 * duas vezes gere de fato duas entregas (é assim que at-least-once aparece pra gente).
 */
export async function sendToQueue(config: AppConfig, queueName: string, body: unknown, groupId: string) {
  const sqs = new SqsGateway(config);
  try {
    await sqs.client.send(
      new SendMessageCommand({
        QueueUrl: await sqs.queueUrl(queueName),
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: randomUUID(),
      }),
    );
  } finally {
    sqs.close();
  }
}

export async function drainQueue(config: AppConfig, queueName: string, waitSeconds = 1) {
  const sqs = new SqsGateway(config);
  const bodies: Array<{ body: any; attributes: Record<string, string | undefined> }> = [];
  try {
    for (let empty = 0; empty < 2; ) {
      const messages = await sqs.receive(queueName, { max: 10, waitSeconds, visibilitySeconds: 30 });
      if (messages.length === 0) {
        empty++;
        continue;
      }
      for (const m of messages) {
        let body: unknown = m.Body;
        try {
          body = JSON.parse(m.Body ?? 'null');
        } catch {
          // mantém o corpo cru (mensagens malformadas)
        }
        bodies.push({
          body,
          attributes: Object.fromEntries(
            Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue]),
          ),
        });
        if (m.ReceiptHandle) await sqs.delete(queueName, m.ReceiptHandle);
      }
    }
  } finally {
    sqs.close();
  }
  return bodies;
}

// ---- asserções -------------------------------------------------------------

export async function eventually<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await probe();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(intervalMs);
    last = await probe();
  }
  return last;
}

export async function walletState(walletId: string) {
  const [row] = await sql`
    SELECT w.balance::text AS balance, w.version,
           COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                       FROM wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)::numeric(20,2)::text AS rebuilt,
           (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries,
           (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND direction = 'DEBIT') AS debits,
           (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND direction = 'CREDIT') AS credits
      FROM wallets w WHERE w.id = ${walletId}`;
  return row as { balance: string; version: number; rebuilt: string; entries: number; debits: number; credits: number };
}

/** A invariante final de todo teste: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectConsistent(walletId: string): Promise<Awaited<ReturnType<typeof walletState>>> {
  const state = await walletState(walletId);
  expect(state).toBeDefined();
  expect(state.balance).toBe(state.rebuilt);
  // versão 1 = criação; um lançamento por mudança de saldo depois disso (+ o de abertura, se houver)
  expect(state.version - 1).toBe(state.entries - (await hasOpeningEntry(walletId) ? 1 : 0));
  return state;
}

async function hasOpeningEntry(walletId: string): Promise<boolean> {
  const [row] = await sql`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND wallet_version = 1`;
  return (row as { n: number }).n === 1;
}

export async function transactionsOf(walletId: string) {
  return (await sql`
    SELECT id, external_transaction_id, kind, status, failure_code, amount::text AS amount
      FROM wager_transactions WHERE wallet_id = ${walletId} AND kind <> 'OPENING'
     ORDER BY created_at, id`) as Array<{
    id: string;
    external_transaction_id: string;
    kind: string;
    status: string;
    failure_code: string | null;
    amount: string;
  }>;
}
