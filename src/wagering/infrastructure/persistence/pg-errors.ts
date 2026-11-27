import { InvariantViolationError } from '../../../shared/domain/errors';
import { ApplicationError, TransientInfrastructureError } from '../../application/errors';

/** SQLSTATEs seguros para repetir: a transação sofreu rollback e nada foi aplicado. */
const TRANSIENT_SQLSTATES: Record<string, string> = {
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
  '55P03': 'lock_not_available',
  '57014': 'statement_timeout',
  '57P01': 'admin_shutdown',
  '57P02': 'crash_shutdown',
  '57P03': 'cannot_connect_now',
  '53300': 'too_many_connections',
  '53400': 'configuration_limit_exceeded',
  '08000': 'connection_exception',
  '08003': 'connection_does_not_exist',
  '08006': 'connection_failure',
  '08001': 'sqlclient_unable_to_establish_sqlconnection',
  '08004': 'sqlserver_rejected_establishment_of_sqlconnection',
};

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/** Violações de integridade: determinísticas, repetir não ajuda. WG001 é lançado pelos nossos triggers. */
const INVARIANT_SQLSTATES = new Set(['WG001', '23514', '23502', '23503']);

function collectCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: unknown; sqlState?: unknown; errno?: unknown; cause?: unknown; previous?: unknown };
    for (const candidate of [e.code, e.sqlState]) {
      if (typeof candidate === 'string') codes.push(candidate);
    }
    current = e.cause ?? e.previous;
  }
  return codes;
}

export function sqlStateOf(error: unknown): string | undefined {
  return collectCodes(error).find((c) => /^[0-9A-Z]{5}$/.test(c));
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!collectCodes(error).includes('23505')) return false;
  if (!constraint) return true;
  const message = String((error as { message?: unknown }).message ?? '');
  const detail = (error as { constraint?: unknown }).constraint;
  return detail === constraint || message.includes(constraint);
}

/**
 * Traduz erros do driver/ORM para a taxonomia de erros da aplicação, assim ninguém
 * depende de código do Postgres: transitório → retry; invariante → falha permanente.
 */
export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof ApplicationError) return error;
  const codes = collectCodes(error);
  for (const code of codes) {
    const reason = TRANSIENT_SQLSTATES[code];
    if (reason) return new TransientInfrastructureError(`Database temporarily unavailable (${reason})`, reason, error);
    if (TRANSIENT_NODE_CODES.has(code)) return new TransientInfrastructureError(`Database unreachable (${code})`, code, error);
    if (INVARIANT_SQLSTATES.has(code)) {
      return new InvariantViolationError(`Database integrity check failed (${code}): ${(error as Error).message}`);
    }
  }
  const message = String((error as { message?: unknown })?.message ?? '');
  if (/Timeout acquiring a connection|Connection terminated|connect ECONNREFUSED|Client has encountered a connection error/i.test(message)) {
    return new TransientInfrastructureError('Database connection unavailable', 'connection', error);
  }
  return error;
}
