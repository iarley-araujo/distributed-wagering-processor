import { DomainValidationError, InvalidTransactionStateError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { FailureCode, REJECTION_CODES } from './failure-code';
import { assertSubmittable, computePayloadHash, type WagerPayload } from './wager-payload';
import { TERMINAL_STATUSES, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction-kind';
import { invertDirection, LedgerDirection } from './wallet-ledger-entry';

export { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction-kind';

export const INTERNAL_PROVIDER_ID = '__internal__';

export interface CreateWagerTransactionProps extends WagerPayload {
  id: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo da wallet observado quando a transação chegou no status atual (snapshot do replay). */
  resultingBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

/**
 * Transições válidas:
 *
 *   PENDING ──────────┬─▶ PROCESSED   (aplicada, terminal)
 *                     ├─▶ REJECTED    (regra de negócio, terminal)
 *                     ├─▶ FAILED      (erro permanente de infra, terminal)
 *                     └─▶ PENDING_REFERENCE
 *   PENDING_REFERENCE ┬─▶ PENDING_REFERENCE (retry reagendado, attempts + 1)
 *                     ├─▶ PROCESSED
 *                     ├─▶ REJECTED    (ex.: REFERENCE_NOT_FOUND depois do orçamento de retries)
 *                     └─▶ FAILED
 *
 * Qualquer transição saindo de um status terminal lança InvalidTransactionStateError: é
 * erro de programação, nunca caminho de negócio. A mesma regra também é garantida por trigger.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não é o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
    private _referenceAttempts: number = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Nasce PENDING. Valida kind submetível, valor positivo e exigência de referência. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertSubmittable(props);
    if (!props.idempotencyKey) {
      throw new DomainValidationError('Idempotency key is required');
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      computePayloadHash(props),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Crédito interno de abertura, criado junto com a wallet. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const payload: WagerPayload = {
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
    };
    return new WagerTransaction(
      props.id,
      payload.providerId,
      payload.externalTransactionId,
      `${INTERNAL_PROVIDER_ID}:${payload.externalTransactionId}`,
      computePayloadHash(payload),
      props.walletId,
      props.playerId,
      payload.roundId,
      payload.gameId,
      payload.kind,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições -----------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultingBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date, observedBalance: Money): void {
    this.assertNotTerminal('markPendingReference');
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._resultingBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined): void {
    this.assertNotTerminal('reject');
    if (!REJECTION_CODES.has(code)) {
      throw new InvalidTransactionStateError(`${code} is not a rejection code`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultingBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    if (REJECTION_CODES.has(code)) {
      throw new InvalidTransactionStateError(`${code} is a rejection code, not a failure code`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio -------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Kinds que esta transação pode referenciar. */
  allowedReferenceKinds(): ReadonlySet<WagerTransactionKind> {
    switch (this.kind) {
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return new Set([WagerTransactionKind.Bet]);
      case WagerTransactionKind.Rollback:
        return new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]);
      default:
        return new Set();
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction depends on its reference');
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}
