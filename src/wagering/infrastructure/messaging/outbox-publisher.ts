import type { AppConfig } from '../../../config/app-config';
import { AppLogger } from '../../../observability/logger';
import type { Metrics } from '../../../observability/metrics';
import { type BackoffPolicy, ExponentialBackoff } from '../../../shared/domain/backoff';
import { BackgroundLoop } from '../../../shared/infrastructure/background-loop';
import type { FaultInjector, OutboxRepository } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { SqsGateway } from './sqs-gateway';

const SQS_MAX_BATCH = 10;
const PUBLISH_LANES = 5;

/**
 * Divide um claim em "lanes" enviadas em paralelo. Todas as mensagens de um aggregate caem
 * na mesma lane e mantêm a ordem, então este publisher preserva a ordem dos eventos por wallet.
 */
function lanesByAggregate(messages: OutboxMessage[], laneCount: number): OutboxMessage[][] {
  const lanes: OutboxMessage[][] = Array.from({ length: laneCount }, () => []);
  for (const message of messages) {
    let hash = 0;
    for (let i = 0; i < message.aggregateId.length; i++) hash = (hash * 31 + message.aggregateId.charCodeAt(i)) | 0;
    lanes[Math.abs(hash) % laneCount]?.push(message);
  }
  return lanes.filter((lane) => lane.length > 0);
}

/**
 * Publica as mensagens commitadas do outbox em `wagering-events.fifo`.
 *
 * Seguro com N publishers ao mesmo tempo: as linhas são reservadas com FOR UPDATE SKIP LOCKED,
 * a lease expira (as linhas de um publisher que morreu voltam a ficar disponíveis) e
 * o `markPublished` só funciona para o dono atual da lease.
 *
 * A entrega é at-least-once: um crash entre o SQS aceitar o lote e o UPDATE do
 * `markPublished` republica o mesmo evento depois. O consumidor continua seguro porque
 * o MessageDeduplicationId do SQS e o `eventId` do envelope são o id do outbox.
 */
export class OutboxPublisher {
  private readonly logger = new AppLogger('OutboxPublisher');
  private readonly loop: BackgroundLoop;
  private readonly backoff: BackoffPolicy;
  private lastStatsAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly outbox: OutboxRepository,
    private readonly sqs: SqsGateway,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
    readonly owner: string = config.instanceId,
  ) {
    this.backoff = new ExponentialBackoff(config.outbox.backoffBaseMs, config.outbox.backoffMaxMs);
    this.loop = new BackgroundLoop('OutboxPublisher', () => this.publishOnce(), config.outbox.pollIntervalMs);
  }

  start(): void {
    this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop(this.config.consumer.shutdownGraceMs);
    try {
      await this.outbox.releaseLeases(this.owner);
    } catch (error) {
      this.logger.warn('could not release outbox leases; they will expire', { error });
    }
  }

  /** Um ciclo claim → publish → mark. Retorna quantas mensagens foram pegas. */
  async publishOnce(): Promise<number> {
    await this.refreshStats();
    const claimed = await this.outbox.claimDue(this.owner, this.config.outbox.leaseMs, this.config.outbox.batchSize);
    if (claimed.length === 0) return 0;

    const ok: string[] = [];
    const failed = new Map<string, string>();
    await Promise.all(
      lanesByAggregate(claimed, PUBLISH_LANES).map(async (lane) => {
        for (let i = 0; i < lane.length; i += SQS_MAX_BATCH) {
          const chunk = lane.slice(i, i + SQS_MAX_BATCH);
          try {
            const result = await this.sqs.sendBatch(
              this.config.sqs.eventsQueueName,
              chunk.map((m) => ({
                id: m.id,
                body: JSON.stringify(m.payload),
                groupId: m.aggregateId,
                deduplicationId: m.id,
                attributes: { eventType: m.eventType, eventId: m.id },
              })),
            );
            ok.push(...result.ok);
            for (const [id, reason] of result.failed) failed.set(id, reason);
            // Mantém a ordem por aggregate: na primeira falha, para esta lane.
            if (result.failed.size > 0) return;
          } catch (error) {
            for (const m of chunk) failed.set(m.id, (error as Error).message ?? 'send failed');
            return;
          }
        }
      }),
    );

    await this.faults.trigger('outbox.afterPublishBeforeMark');

    const now = new Date();
    const published = claimed.filter((m) => ok.includes(m.id));
    if (published.length > 0) {
      const marked = await this.outbox.markPublished(published, this.owner);
      if (marked < published.length) {
        // A lease expirou durante a publicação e outro publisher assumiu: vira uma publicação
        // duplicada, que o consumidor deduplica pelo eventId.
        this.logger.warn('outbox lease lost during publish', { published: published.length, marked });
      }
      for (const message of published) {
        message.markPublished(now);
        this.metrics.outboxPublished.inc({ event_type: message.eventType });
        this.metrics.outboxPublishLag.observe(Math.max(0, (now.getTime() - message.occurredAt.getTime()) / 1000));
      }
    }

    for (const message of claimed.filter((m) => failed.has(m.id) || !ok.includes(m.id))) {
      await this.retryLater(message, failed.get(message.id) ?? 'not acknowledged by SQS', now);
    }
    return claimed.length;
  }

  private async retryLater(message: OutboxMessage, error: string, now: Date): Promise<void> {
    message.scheduleRetry(now, this.backoff);
    this.metrics.outboxFailures.inc();
    this.metrics.retries.inc({ component: 'outbox', reason: 'publish_failed' });
    this.logger.warn('outbox publish failed, rescheduled', {
      outboxId: message.id,
      eventType: message.eventType,
      attempts: message.attempts,
      error,
    });
    await this.outbox.reschedule(message, this.owner, error);
  }

  private async refreshStats(): Promise<void> {
    if (Date.now() - this.lastStatsAt < 1_000) return;
    this.lastStatsAt = Date.now();
    const stats = await this.outbox.stats();
    this.metrics.outboxLag.set(stats.oldestPendingAgeSeconds);
    this.metrics.outboxPending.set(stats.pending);
  }
}
