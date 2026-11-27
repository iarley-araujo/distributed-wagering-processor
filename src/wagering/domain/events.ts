import { uuidv7 } from '../../shared/domain/ids';
import type { MoneyProps } from '../../shared/domain/money';
import type { FailureCode } from './failure-code';
import type { WagerTransaction } from './wager-transaction';
import type { Wallet } from './wallet';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Dados de correlação comuns a todos os eventos gerados ao tratar uma requisição/mensagem. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope serializado que vai no payload do outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }

  /** Todos os eventos usam a wallet como aggregate: é a unidade de consistência e de ordem. */
  protected static envelope<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
    return {
      eventId: uuidv7(ctx.occurredAt.getTime()),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    };
  }
}

/** Campos comuns a todos os eventos de transação. */
export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  status: 'PROCESSED';
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      IntegrationEvent.envelope(wallet.id, ctx, {
        ...transactionData(tx),
        status: 'PROCESSED',
        ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: wallet.balance.toJSON(),
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  status: 'REJECTED';
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.envelope(tx.walletId, ctx, {
        ...transactionData(tx),
        status: 'REJECTED',
        failureCode,
        rejectedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  status: 'PENDING_REFERENCE';
  referenceAttempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      IntegrationEvent.envelope(tx.walletId, ctx, {
        ...transactionData(tx),
        status: 'PENDING_REFERENCE',
        referenceAttempts: tx.referenceAttempts,
        nextAttemptAt: (tx.nextReferenceAttemptAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WagerTransactionFailedData extends WagerTransactionEventData {
  status: 'FAILED';
  failureCode: FailureCode;
  failedAt: string;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionFailedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed(
      IntegrationEvent.envelope(tx.walletId, ctx, {
        ...transactionData(tx),
        status: 'FAILED',
        failureCode,
        failedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.envelope(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
