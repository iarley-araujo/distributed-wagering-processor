import { sha256OfCanonicalJson } from '../../shared/domain/canonical-json';
import { DomainValidationError } from '../../shared/domain/errors';
import type { Money } from '../../shared/domain/money';
import { WagerTransactionKind } from './wager-transaction-kind';

/** Os campos de negócio de uma requisição de aposta — exatamente o que o hash do payload cobre. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export const SUBMITTABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export function assertSubmittable(payload: WagerPayload): void {
  if (!SUBMITTABLE_KINDS.has(payload.kind)) {
    throw new DomainValidationError(`Kind ${payload.kind} cannot be submitted`);
  }
  if (!payload.money.isPositive()) {
    throw new DomainValidationError('Transaction amount must be greater than zero');
  }
  const requiresReference =
    payload.kind === WagerTransactionKind.Refund || payload.kind === WagerTransactionKind.Rollback;
  if (requiresReference && !payload.referenceExternalTransactionId) {
    throw new DomainValidationError(`${payload.kind} requires referenceExternalTransactionId`);
  }
  if (payload.referenceExternalTransactionId === payload.externalTransactionId) {
    throw new DomainValidationError('A transaction cannot reference itself');
  }
}

/**
 * Algoritmo do hash do payload (v1):
 *   sha256_hex( canonicalJson({ providerId, externalTransactionId, playerId, walletId,
 *                               roundId, gameId, kind, money: { amount, currency },
 *                               referenceExternalTransactionId? }) )
 * - JSON canônico = chaves ordenadas recursivamente, sem espaços, opcionais ausentes omitidos;
 * - `money.amount` é normalizado para escala 2 antes, então "25" e "25.00" dão o mesmo hash;
 * - o header Idempotency-Key e metadados de transporte (messageId, occurredAt) ficam de fora.
 */
export function computePayloadHash(payload: WagerPayload): string {
  return sha256OfCanonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}
