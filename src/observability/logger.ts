import type { LoggerService } from '@nestjs/common';
import { logContext } from './log-context';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Chaves que nunca podem ir para o log: payloads completos, valores financeiros e segredos.
 * O log carrega identificadores (correlationId, messageId, transactionId, walletId, providerId)
 * e desfechos (status, failureCode), que é o que precisa para diagnosticar um fluxo.
 */
const REDACTED_KEYS = new Set([
  'payload',
  'body',
  'data',
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'authorization',
  'password',
  'secretAccessKey',
]);

export type LogFields = Record<string, unknown>;

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (REDACTED_KEYS.has(key)) {
      out[key] = '[redacted]';
    } else if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Logger JSON estruturado (um objeto por linha no stdout) ligado ao contexto async. */
export class AppLogger {
  private static minLevel: number = LEVELS.info;
  private static instanceId: string | undefined;

  constructor(private readonly component: string) {}

  static configure(options: { level: Level; instanceId: string }): void {
    AppLogger.minLevel = LEVELS[options.level];
    AppLogger.instanceId = options.instanceId;
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: Level, message: string, fields: LogFields): void {
    if (LEVELS[level] < AppLogger.minLevel) return;
    const line = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      instanceId: AppLogger.instanceId,
      message,
      ...logContext.current(),
      ...sanitize(fields),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}

/** Adaptador para os logs do próprio Nest saírem no mesmo formato JSON. */
export class NestJsonLogger implements LoggerService {
  private readonly logger = new AppLogger('nest');

  log(message: unknown, context?: string): void {
    this.logger.info(String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error(String(message), { context, trace });
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn(String(message), { context });
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }
  verbose(message: unknown, context?: string): void {
    this.logger.debug(String(message), { context });
  }
}
