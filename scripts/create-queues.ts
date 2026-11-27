import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { type AppConfig, loadConfig } from '../src/config/app-config';
import { SqsGateway } from '../src/wagering/infrastructure/messaging/sqs-gateway';

/**
 * Cria as filas FIFO (pode rodar várias vezes, é idempotente):
 *   wager-transactions-dlq.fifo   dead letters (retenção de 14 dias)
 *   wager-transactions.fifo       entrada; RedrivePolicy → DLQ depois de CONSUMER_MAX_ATTEMPTS + 2 recebimentos
 *                                 (rede de segurança — o próprio consumer manda pra DLQ em MAX_ATTEMPTS)
 *   wagering-events.fifo          eventos de integração publicados a partir do outbox
 */
export async function createQueues(config: AppConfig): Promise<void> {
  const sqs = new SqsGateway(config);
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  try {
    await sqs.client.send(
      new CreateQueueCommand({
        QueueName: config.sqs.wagerDlqName,
        Attributes: { ...fifo, MessageRetentionPeriod: '1209600' },
      }),
    );
    const dlqUrl = await sqs.queueUrl(config.sqs.wagerDlqName);
    const dlqArn = (
      await sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn;

    await sqs.client.send(
      new CreateQueueCommand({
        QueueName: config.sqs.wagerQueueName,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(config.consumer.visibilityTimeoutSeconds),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: config.consumer.maxAttempts + 2,
          }),
        },
      }),
    );
    await sqs.client.send(new CreateQueueCommand({ QueueName: config.sqs.eventsQueueName, Attributes: fifo }));
  } finally {
    sqs.close();
  }
}

if (import.meta.main) {
  const config = loadConfig();
  // O emulador às vezes aceita conexão antes do SQS estar pronto: tento por até ~30s.
  for (let attempt = 1; ; attempt++) {
    try {
      await createQueues(config);
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await Bun.sleep(1_000);
    }
  }
  console.log(
    JSON.stringify({ created: [config.sqs.wagerDlqName, config.sqs.wagerQueueName, config.sqs.eventsQueueName] }),
  );
}
