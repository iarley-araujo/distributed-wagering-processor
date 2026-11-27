import { z } from 'zod';
import { DomainError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { ApplicationError } from '../application/errors';
import { INTERNAL_PROVIDER_ID } from '../domain/wager-transaction';
import { assertSubmittable, type WagerPayload } from '../domain/wager-payload';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';

/*
 * Contratos de entrada compartilhados por HTTP e SQS. Primeiro a validação estrutural (zod),
 * depois os value objects do domínio (Money) e as regras (assertSubmittable) — o mesmo caminho
 * para os dois transportes, então eles nunca aceitam entradas diferentes.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '));
  }
}

const identifier = (max: number) => z.string().min(1).max(max).regex(/^[\x21-\x7E]+$/, 'must be printable ASCII without spaces');

export const moneySchema = z.object({ amount: z.string(), currency: z.string() }).strict();

export const wagerDataSchema = z
  .object({
    providerId: identifier(64).refine((v) => v !== INTERNAL_PROVIDER_ID, 'reserved provider id'),
    externalTransactionId: identifier(128),
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: identifier(128),
    gameId: identifier(128),
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: moneySchema,
    referenceExternalTransactionId: identifier(128).optional(),
  })
  .strict();

export const idempotencyKeySchema = identifier(255);

export const wagerMessageSchema = z
  .object({
    messageId: identifier(256),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime({ offset: true }),
    data: wagerDataSchema.extend({ idempotencyKey: idempotencyKeySchema }).strict(),
  })
  .strict();

export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export const createWalletSchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: moneySchema,
  })
  .strict();

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(zodIssues(result.error));
  return result.data;
}

export function parseMoney(input: z.infer<typeof moneySchema>, path: string): Money {
  try {
    return Money.from(input);
  } catch (error) {
    if (error instanceof DomainError) throw new RequestValidationError([{ path, message: error.message }]);
    throw error;
  }
}

/** Dados validados → payload do domínio. Lança RequestValidationError com o caminho exato do campo. */
export function toWagerPayload(data: z.infer<typeof wagerDataSchema>): WagerPayload {
  const payload: WagerPayload = {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId.toLowerCase(),
    walletId: data.walletId.toLowerCase(),
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: parseMoney(data.money, 'money'),
    referenceExternalTransactionId: data.referenceExternalTransactionId,
  };
  try {
    assertSubmittable(payload);
  } catch (error) {
    if (error instanceof DomainError) throw new RequestValidationError([{ path: '', message: error.message }]);
    throw error;
  }
  return payload;
}
