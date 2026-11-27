import { hostname } from 'node:os';

export type AppRole = 'api' | 'consumer' | 'outbox' | 'pending-references';
const ALL_ROLES: AppRole[] = ['api', 'consumer', 'outbox', 'pending-references'];

export interface AppConfig {
  instanceId: string;
  roles: ReadonlySet<AppRole>;
  http: { port: number };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  };
  aws: {
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sqs: {
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
  };
  consumer: {
    name: string;
    maxAttempts: number;
    batchSize: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    shutdownGraceMs: number;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
  };
  pendingReferences: {
    pollIntervalMs: number;
    batchSize: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    maxAttempts: number;
  };
  /** Só para testes: injeção de falhas, ex. "consumer.afterCommitBeforeAck=crash". Vazio em produção. */
  faultInjection: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return value;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const roles = str(env, 'APP_ROLES', ALL_ROLES.join(','))
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  for (const role of roles) {
    if (!ALL_ROLES.includes(role as AppRole)) throw new Error(`Unknown role in APP_ROLES: ${role}`);
  }
  const logLevel = str(env, 'LOG_LEVEL', 'info');
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error(`Invalid LOG_LEVEL: ${logLevel}`);

  return {
    instanceId: str(env, 'INSTANCE_ID', `${hostname()}-${process.pid}`),
    roles: new Set(roles as AppRole[]),
    http: { port: int(env, 'PORT', 3000) },
    logLevel: logLevel as AppConfig['logLevel'],
    database: {
      url: str(env, 'DATABASE_URL', 'postgresql://wagering:wagering@localhost:5432/wagering'),
      poolMin: int(env, 'DB_POOL_MIN', 2),
      poolMax: int(env, 'DB_POOL_MAX', 20),
      lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000),
      statementTimeoutMs: int(env, 'DB_STATEMENT_TIMEOUT_MS', 15_000),
    },
    aws: {
      region: str(env, 'AWS_REGION', 'us-east-1'),
      endpoint: env.AWS_ENDPOINT_URL || undefined,
      accessKeyId: str(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      wagerQueueName: str(env, 'SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      wagerDlqName: str(env, 'SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueueName: str(env, 'SQS_EVENTS_QUEUE', 'wagering-events.fifo'),
    },
    consumer: {
      name: str(env, 'CONSUMER_NAME', 'wager-transactions-consumer'),
      maxAttempts: int(env, 'CONSUMER_MAX_ATTEMPTS', 5),
      batchSize: int(env, 'CONSUMER_BATCH_SIZE', 10),
      waitTimeSeconds: int(env, 'CONSUMER_WAIT_TIME_SECONDS', 10),
      visibilityTimeoutSeconds: int(env, 'CONSUMER_VISIBILITY_TIMEOUT_SECONDS', 30),
      backoffBaseMs: int(env, 'CONSUMER_BACKOFF_BASE_MS', 1_000),
      backoffMaxMs: int(env, 'CONSUMER_BACKOFF_MAX_MS', 60_000),
      shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 20_000),
    },
    outbox: {
      pollIntervalMs: int(env, 'OUTBOX_POLL_INTERVAL_MS', 250),
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50),
      leaseMs: int(env, 'OUTBOX_LEASE_MS', 30_000),
      backoffBaseMs: int(env, 'OUTBOX_BACKOFF_BASE_MS', 500),
      backoffMaxMs: int(env, 'OUTBOX_BACKOFF_MAX_MS', 60_000),
    },
    pendingReferences: {
      pollIntervalMs: int(env, 'PENDING_REF_POLL_INTERVAL_MS', 1_000),
      batchSize: int(env, 'PENDING_REF_BATCH_SIZE', 50),
      backoffBaseMs: int(env, 'PENDING_REF_BACKOFF_BASE_MS', 2_000),
      backoffMaxMs: int(env, 'PENDING_REF_BACKOFF_MAX_MS', 300_000),
      maxAttempts: int(env, 'PENDING_REF_MAX_ATTEMPTS', 10),
    },
    faultInjection: str(env, 'FAULT_INJECTION', ''),
  };
}
