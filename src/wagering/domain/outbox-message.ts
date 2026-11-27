import { type BackoffPolicy, ExponentialBackoff } from '../../shared/domain/backoff';
import { InvalidTransactionStateError } from '../../shared/domain/errors';
import type { IntegrationEvent } from './events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export const DEFAULT_OUTBOX_BACKOFF: BackoffPolicy = new ExponentialBackoff(500, 60_000);

/**
 * Evento de integração esperando para ser publicado. O id É o id do evento, então uma
 * republicação depois de um crash leva o mesmo id e o consumidor consegue deduplicar.
 *
 * De propósito não existe estado de "desistir": um evento commitado tem que ser
 * publicado em algum momento, então os retries vão espaçando até um teto e continuam (e aparecem como lag).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial). */
  scheduleRetry(now: Date, backoff: BackoffPolicy = DEFAULT_OUTBOX_BACKOFF): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoff.delayMs(this._attempts));
  }
}
