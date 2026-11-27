import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../wagering/application/errors';
import type { TransactionSource, WageringTelemetry } from '../wagering/application/ports';

const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LOCK_REASONS = new Set(['lock_not_available', 'deadlock_detected', 'serialization_failure']);

/**
 * Métricas Prometheus. Um registry por instância da aplicação (nos testes várias instâncias
 * podem rodar no mesmo processo). Expostas em GET /metrics.
 */
export class Metrics implements WageringTelemetry {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions that reached a status, by kind/status/source (replays excluded)',
    labelNames: ['kind', 'status', 'source'],
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicate deliveries detected, by mechanism (idempotency_key | inbox)',
    labelNames: ['mechanism'],
    registers: [this.registry],
  });
  readonly idempotencyConflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Same idempotency key received with a different payload',
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled, by component and reason',
    labelNames: ['component', 'reason'],
    registers: [this.registry],
  });
  readonly dlq = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages moved to the dead-letter queue, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks, serialization failures and optimistic version conflicts',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  readonly lockWait = new Histogram({
    name: 'wagering_wallet_lock_wait_seconds',
    help: 'Time spent acquiring the wallet row lock (SELECT ... FOR UPDATE)',
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction, by source',
    labelNames: ['source'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending_messages',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  readonly outboxPublishLag = new Histogram({
    name: 'wagering_outbox_publish_delay_seconds',
    help: 'Delay between event occurrence (commit) and successful publication',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox messages published',
    labelNames: ['event_type'],
    registers: [this.registry],
  });
  readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Outbox publication failures (retried with backoff)',
    registers: [this.registry],
  });
  readonly consumerMessages = new Counter({
    name: 'wagering_consumer_messages_total',
    help: 'Queue messages handled by the consumer, by outcome',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  readonly reconciliations = new Counter({
    name: 'wagering_reconciliation_checks_total',
    help: 'Reconciliation checks, by result',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliation checks that found stored balance != ledger balance',
    registers: [this.registry],
  });
  readonly pendingReferenceResolutions = new Counter({
    name: 'wagering_pending_reference_resolutions_total',
    help: 'Pending-reference worker outcomes',
    labelNames: ['result'],
    registers: [this.registry],
  });
  readonly httpRequests = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'HTTP request latency by route and status code',
    labelNames: ['method', 'route', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  constructor() {
    try {
      collectDefaultMetrics({ register: this.registry });
    } catch {
      // Algumas métricas de runtime não existem em todo runtime; as de negócio não são afetadas.
    }
  }

  // ---- WageringTelemetry ----------------------------------------------------
  transactionSettled(input: { kind: string; status: string; source: TransactionSource }): void {
    this.transactions.inc({ kind: input.kind, status: input.status, source: input.source });
  }
  duplicateDetected(mechanism: 'idempotency_key' | 'inbox'): void {
    this.duplicates.inc({ mechanism });
  }
  idempotencyConflict(): void {
    this.idempotencyConflicts.inc();
  }
  walletLockAcquired(waitSeconds: number): void {
    this.lockWait.observe(waitSeconds);
  }
  processingDuration(source: TransactionSource, seconds: number): void {
    this.processing.observe({ source }, seconds);
  }
  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? 'consistent' : 'divergent' });
    if (!consistent) this.reconciliationDivergences.inc();
  }

  /** Conta falhas ligadas a lock em qualquer lugar onde apareçam (filtro HTTP, consumer, workers). */
  observeFailure(error: unknown): void {
    if (error instanceof ConcurrencyConflictError) {
      this.lockConflicts.inc({ reason: 'version_conflict' });
    } else if (error instanceof TransientInfrastructureError && LOCK_REASONS.has(error.reason)) {
      this.lockConflicts.inc({ reason: error.reason });
    }
  }
}
