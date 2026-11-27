import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AppLogger } from '../../../observability/logger';
import type { Metrics } from '../../../observability/metrics';
import { DomainError, InvariantViolationError } from '../../../shared/domain/errors';
import {
  ApplicationError,
  ConcurrencyConflictError,
  InvalidCursorError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { RequestValidationError } from '../contracts';

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
}

/** Erros do tipo conflito lançados pelos controllers (não são exceções do use case). */
export class HttpConflictError extends ApplicationError {
  constructor(
    readonly code: 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message);
  }
}

export class MissingIdempotencyKeyError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  constructor() {
    super('The Idempotency-Key header is required');
  }
}

/**
 * Mapeamento único erro → status HTTP, aplicado em todos os endpoints:
 *   400 VALIDATION_ERROR / IDEMPOTENCY_KEY_REQUIRED / INVALID_CURSOR   corrigir a requisição
 *   404 WALLET_NOT_FOUND / TRANSACTION_NOT_FOUND
 *   409 IDEMPOTENCY_KEY_CONFLICT / EXTERNAL_TRANSACTION_ID_CONFLICT / WALLET_ALREADY_EXISTS
 *   503 TRANSIENT_FAILURE (+ Retry-After)                               repetir a mesma requisição
 *   500 INTERNAL_ERROR / INVARIANT_VIOLATION                            nada foi commitado
 * (422 rejeição de negócio e 202 pendente são submissões bem-sucedidas, ver presenters.)
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new AppLogger('HttpErrorFilter');

  constructor(private readonly metrics: Metrics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, retryAfterSeconds } = this.map(exception);
    this.metrics.observeFailure(exception);
    if (status >= 500) {
      this.logger.error('request failed', { status, code: body.error.code, error: exception });
    }
    if (retryAfterSeconds) response.setHeader('Retry-After', String(retryAfterSeconds));
    response.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody; retryAfterSeconds?: number } {
    const body = (code: string, message: string, retryable: boolean, details?: unknown): ErrorBody => ({
      error: { code, message, retryable, ...(details !== undefined ? { details } : {}) },
    });

    if (exception instanceof RequestValidationError) {
      return { status: 400, body: body(exception.code, 'Invalid request', false, exception.issues) };
    }
    if (exception instanceof MissingIdempotencyKeyError || exception instanceof InvalidCursorError) {
      return { status: 400, body: body(exception.code, exception.message, false) };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return { status: 404, body: body(exception.code, exception.message, false) };
    }
    if (exception instanceof HttpConflictError) {
      return {
        status: 409,
        body: body(exception.code, exception.message, false, { existingTransactionId: exception.existingTransactionId }),
      };
    }
    if (exception instanceof WalletAlreadyExistsError) {
      return { status: 409, body: body(exception.code, exception.message, false) };
    }
    if (exception instanceof TransientInfrastructureError || exception instanceof ConcurrencyConflictError) {
      return {
        status: 503,
        body: body('TRANSIENT_FAILURE', 'Temporary failure; retry the same request', true),
        retryAfterSeconds: 1,
      };
    }
    if (exception instanceof InvariantViolationError) {
      return { status: 500, body: body(exception.code, 'Integrity check failed; nothing was applied', false) };
    }
    if (exception instanceof DomainError) {
      return { status: 400, body: body('VALIDATION_ERROR', exception.message, false) };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        ({ 400: 'VALIDATION_ERROR', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND' } as Record<number, string>)[
          status
        ] ?? 'HTTP_ERROR';
      return { status, body: body(code, exception.message, false) };
    }
    return { status: 500, body: body('INTERNAL_ERROR', 'Unexpected error; nothing was applied', true) };
  }
}
