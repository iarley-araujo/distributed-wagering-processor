import type { Money } from '../../shared/domain/money';
import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

// ---- repositórios (implementados pelo adaptador de persistência) ----------

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE na linha da wallet: é o ponto de serialização por wallet. */
  lockById(id: string): Promise<Wallet | null>;
  /** Lança WalletAlreadyExistsError se já existir (playerId, currency). */
  insert(wallet: Wallet): Promise<void>;
  /** Update condicional `WHERE version = expectedVersion`; lança ConcurrencyConflictError se afetar 0 linhas. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** INSERT ... ON CONFLICT DO NOTHING. Retorna false se já existe linha com a mesma key/external id. */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  /** Grava os campos de status; `WHERE status = expectedStatus` protege contra transições concorrentes. */
  update(transaction: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  /** Antecipa a próxima tentativa das linhas PENDING_REFERENCE que esperam por (providerId, externalTransactionId). */
  nudgePendingDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  countByStatus(): Promise<Record<string, number>>;
}

export interface LedgerPageQuery {
  walletId: string;
  /** Limite superior exclusivo de walletVersion (a página continua abaixo dele). */
  beforeVersion?: number;
  limit: number;
}

export interface LedgerSummary {
  entries: number;
  /** Σ créditos − Σ débitos (só fica negativo se o dado estiver corrompido). */
  net: Money;
  lastVersion?: number;
  lastBalanceAfter?: Money;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(query: LedgerPageQuery): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING em (consumerName, messageId). */
  tryInsert(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  leaseOwner: string;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /**
   * Reserva (lease) de forma atômica até `limit` mensagens vencidas e não publicadas para `owner`
   * (FOR UPDATE SKIP LOCKED + expiração da lease), assim publishers concorrentes nunca
   * pegam a mesma linha enquanto a lease estiver valendo.
   */
  claimDue(owner: string, leaseMs: number, limit: number): Promise<OutboxMessage[]>;
  /** Só marca como publicada se `owner` ainda for o dono da lease. Retorna as linhas atualizadas. */
  markPublished(messages: OutboxMessage[], owner: string): Promise<number>;
  reschedule(message: OutboxMessage, owner: string, error: string): Promise<void>;
  releaseLeases(owner: string): Promise<number>;
  stats(): Promise<OutboxStats>;
}

/** Repositórios presos a uma transação do banco. */
export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  isolation?: 'read_committed' | 'repeatable_read';
  readOnly?: boolean;
}

/**
 * Roda `work` dentro de uma única transação SQL. Tudo que é escrito pelo scope
 * entra junto ou sai junto. Erros de infraestrutura são traduzidos para
 * TransientInfrastructureError / InvariantViolationError.
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** Acesso sem transação para os workers (statements únicos com auto-commit). */
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

// ---- outras portas --------------------------------------------------------

export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('CLOCK');

export type FaultPoint =
  | 'process.beforeCommit'
  | 'consumer.afterCommitBeforeAck'
  | 'outbox.afterPublishBeforeMark';

/** Costura de teste para simular crash/falha em pontos exatos. Não faz nada em produção. */
export interface FaultInjector {
  trigger(point: FaultPoint): Promise<void>;
}
export const FAULT_INJECTOR = Symbol('FAULT_INJECTOR');

export type TransactionSource = 'http' | 'sqs' | 'worker' | 'internal';

/** O que a aplicação reporta; o adaptador de observabilidade transforma isso em métricas. */
export interface WageringTelemetry {
  transactionSettled(input: { kind: string; status: string; source: TransactionSource }): void;
  duplicateDetected(mechanism: 'idempotency_key' | 'inbox'): void;
  idempotencyConflict(): void;
  walletLockAcquired(waitSeconds: number): void;
  processingDuration(source: TransactionSource, seconds: number): void;
  reconciliationChecked(consistent: boolean): void;
}
export const TELEMETRY = Symbol('TELEMETRY');
