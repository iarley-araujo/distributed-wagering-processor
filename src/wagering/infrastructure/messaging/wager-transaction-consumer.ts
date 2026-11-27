import type { Message } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../../config/app-config';
import { AppLogger } from '../../../observability/logger';
import { logContext } from '../../../observability/log-context';
import type { Metrics } from '../../../observability/metrics';
import { type BackoffPolicy, ExponentialBackoff } from '../../../shared/domain/backoff';
import { sha256OfCanonicalJson } from '../../../shared/domain/canonical-json';
import { DomainError, InvariantViolationError } from '../../../shared/domain/errors';
import { PermanentMessageError } from '../../application/errors';
import type { FaultInjector } from '../../application/ports';
import type { ProcessWagerTransaction, SubmitWagerCommand } from '../../application/process-wager-transaction';
import type { RecordProcessingFailure } from '../../application/record-processing-failure';
import { parseWith, RequestValidationError, toWagerPayload, wagerMessageSchema } from '../../interfaces/contracts';
import type { SqsGateway } from './sqs-gateway';

type Disposition =
  | { action: 'ack'; outcome: string }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string; detail: string };

/**
 * Consumer SQS da fila `wager-transactions.fifo`.
 *
 * - Reaproveita o ProcessWagerTransaction (mesmo use case do HTTP) com um recibo de inbox, então a
 *   linha do inbox commita junto com os efeitos; reentregas viram no-op.
 * - Só apaga (ack) depois que o use case retornou, ou seja, depois do COMMIT.
 * - Taxonomia de erros:
 *     desfecho de negócio (processada/rejeitada/conflito/wallet inexistente) → ack
 *     transitório (DB fora, lock timeout, deadlock, desconhecido)            → backoff na visibilidade, retry
 *     permanente (malformada, inválida, violação de invariante)             → DLQ na hora
 *     orçamento de retries esgotado (ApproximateReceiveCount ≥ max)          → registro FAILED (best effort) + DLQ
 *   O RedrivePolicy da fila (maxReceiveCount = max + 2) é a rede de segurança para mensagens
 *   venenosas que derrubam o processo antes deste código conseguir roteá-las.
 * - Mensagens do mesmo MessageGroupId são processadas em sequência (em ordem); grupos em paralelo.
 * - No shutdown: para de buscar, termina as mensagens em andamento e devolve as que nem começaram
 *   para a fila (visibilidade 0).
 */
export class WagerTransactionConsumer {
  private readonly logger = new AppLogger('WagerTransactionConsumer');
  private running = false;
  private abort = new AbortController();
  private loopPromise: Promise<void> = Promise.resolve();
  private readonly backoff: BackoffPolicy;

  constructor(
    private readonly config: AppConfig,
    private readonly sqs: SqsGateway,
    private readonly processWager: ProcessWagerTransaction,
    private readonly recordFailure: RecordProcessingFailure,
    private readonly metrics: Metrics,
    private readonly faults: FaultInjector,
  ) {
    this.backoff = new ExponentialBackoff(config.consumer.backoffBaseMs, config.consumer.backoffMaxMs);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
    this.logger.info('consumer started', { queue: this.config.sqs.wagerQueueName });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceExpired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.config.consumer.shutdownGraceMs);
    });
    const result = await Promise.race([this.loopPromise.then(() => 'done' as const), graceExpired]);
    clearTimeout(timer);
    this.logger.info('consumer stopped', { drained: result === 'done' });
  }

  private async loop(): Promise<void> {
    const { consumer, sqs } = this.config;
    while (this.running) {
      let messages: Message[];
      try {
        messages = await this.sqs.receive(sqs.wagerQueueName, {
          max: consumer.batchSize,
          waitSeconds: consumer.waitTimeSeconds,
          visibilitySeconds: consumer.visibilityTimeoutSeconds,
          signal: this.abort.signal,
        });
      } catch (error) {
        if (!this.running) break;
        this.logger.error('receive failed', { error });
        this.metrics.retries.inc({ component: 'consumer', reason: 'receive_failed' });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (messages.length > 0) await this.handleBatch(messages);
    }
  }

  async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
  }

  private async handleGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as Message;
      if (!this.running) {
        await this.release(messages.slice(i));
        return;
      }
      const settled = await this.handleMessage(message);
      if (!settled) {
        // Mantém a ordem FIFO dentro do grupo: as próximas mensagens esperam a que falhou.
        await this.release(messages.slice(i + 1));
        return;
      }
    }
  }

  /** Retorna true se a mensagem saiu da fila (ack ou DLQ). */
  private async handleMessage(message: Message): Promise<boolean> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? message.MessageId ?? 'unknown';

    return logContext.run({ correlationId, messageId: message.MessageId }, async () => {
      try {
        const disposition = await this.process(message, receiveCount, correlationId);
        this.metrics.consumerMessages.inc({ outcome: disposition.action });
        switch (disposition.action) {
          case 'ack':
            await this.faults.trigger('consumer.afterCommitBeforeAck');
            await this.ack(message);
            return true;
          case 'dlq':
            return await this.deadLetter(message, disposition.reason, disposition.detail, receiveCount);
          case 'retry': {
            const delayMs = this.backoff.delayMs(receiveCount);
            this.metrics.retries.inc({ component: 'consumer', reason: disposition.reason });
            this.logger.warn('message scheduled for retry', { reason: disposition.reason, receiveCount, delayMs });
            await this.changeVisibility(message, delayMs / 1000);
            return false;
          }
        }
      } catch (error) {
        // Qualquer coisa inesperada entre o commit e o ack: deixo a mensagem em voo; ela volta
        // depois do visibility timeout e o inbox transforma a reentrega em no-op.
        this.logger.error('message handling aborted before ack', { error, receiveCount });
        return false;
      }
    });
  }

  private async process(message: Message, receiveCount: number, correlationId: string): Promise<Disposition> {
    let command: SubmitWagerCommand;
    let envelope;
    try {
      envelope = parseWith(wagerMessageSchema, JSON.parse(message.Body ?? ''));
      const { idempotencyKey, ...data } = envelope.data;
      command = { idempotencyKey, payload: toWagerPayload(data) };
    } catch (error) {
      const detail = error instanceof RequestValidationError ? error.message : 'body is not valid JSON';
      return { action: 'dlq', reason: 'MALFORMED_MESSAGE', detail };
    }
    logContext.assign({ messageId: envelope.messageId, walletId: command.payload.walletId, providerId: command.payload.providerId });

    // Hash do inbox: a identidade de negócio da mensagem (timestamps de transporte ficam de fora).
    const inbox = {
      consumerName: this.config.consumer.name,
      messageId: envelope.messageId,
      payloadHash: sha256OfCanonicalJson({ messageId: envelope.messageId, type: envelope.type, data: envelope.data }),
    };

    try {
      const result = await this.processWager.execute(command, {
        source: 'sqs',
        correlationId,
        causationId: envelope.messageId,
        inbox,
      });
      return { action: 'ack', outcome: result.type };
    } catch (error) {
      this.metrics.observeFailure(error);
      if (error instanceof PermanentMessageError) {
        return { action: 'dlq', reason: error.code, detail: error.message };
      }
      if (error instanceof InvariantViolationError) {
        await this.tryRecordFailure(command, inbox, correlationId);
        return { action: 'dlq', reason: 'INVARIANT_VIOLATION', detail: error.message };
      }
      if (error instanceof DomainError) {
        return { action: 'dlq', reason: error.code, detail: error.message };
      }
      const reason = (error as { code?: string }).code ?? 'UNKNOWN';
      if (receiveCount >= this.config.consumer.maxAttempts) {
        await this.tryRecordFailure(command, inbox, correlationId);
        return { action: 'dlq', reason: 'RETRIES_EXHAUSTED', detail: `${reason}: ${(error as Error).message}` };
      }
      this.logger.warn('transient processing failure', { error, receiveCount });
      return { action: 'retry', reason };
    }
  }

  private async tryRecordFailure(
    command: SubmitWagerCommand,
    inbox: { consumerName: string; messageId: string; payloadHash: string },
    correlationId: string,
  ): Promise<void> {
    try {
      await this.recordFailure.execute(command, inbox, correlationId);
    } catch (error) {
      this.logger.error('could not record FAILED transaction; DLQ keeps the evidence', { error });
    }
  }

  private async deadLetter(message: Message, reason: string, detail: string, receiveCount: number): Promise<boolean> {
    try {
      await this.sqs.send(this.config.sqs.wagerDlqName, {
        body: message.Body ?? '',
        groupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        deduplicationId: `${message.MessageId}:dlq`,
        attributes: {
          failureReason: reason,
          failureDetail: detail.slice(0, 1024),
          originalMessageId: message.MessageId ?? '',
          receiveCount: String(receiveCount),
          consumer: this.config.consumer.name,
        },
      });
    } catch (error) {
      // Não apagou → vai ser reentregue depois (e o redrive policy é o último recurso).
      this.logger.error('could not move message to DLQ', { error, reason });
      return false;
    }
    this.metrics.dlq.inc({ reason });
    this.logger.error('message moved to DLQ', { reason, detail, receiveCount });
    await this.ack(message);
    return true;
  }

  private async ack(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      await this.sqs.delete(this.config.sqs.wagerQueueName, message.ReceiptHandle);
    } catch (error) {
      // Os efeitos já estão commitados; a reentrega vai bater no inbox e receber ack nessa hora.
      this.logger.warn('ack failed; message will be redelivered and deduplicated', { error });
    }
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      await this.sqs.changeVisibility(this.config.sqs.wagerQueueName, message.ReceiptHandle, seconds);
    } catch (error) {
      this.logger.warn('could not change visibility; default visibility timeout applies', { error });
    }
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((m) => this.changeVisibility(m, 0)));
  }
}
