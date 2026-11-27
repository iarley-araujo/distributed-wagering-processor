import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../../config/app-config';

export interface FifoMessage {
  id: string;
  body: string;
  groupId: string;
  deduplicationId: string;
  attributes?: Record<string, string>;
}

/** Camada fina sobre o AWS SDK: resolve/cacheia URL das filas e helpers pensados para FIFO. */
export class SqsGateway {
  readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(config: AppConfig) {
    this.client = new SQSClient({
      region: config.aws.region,
      endpoint: config.aws.endpoint,
      credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
      maxAttempts: 3,
    });
  }

  queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`Queue ${name} not found`);
        return r.QueueUrl;
      });
      url.catch(() => this.urls.delete(name));
      this.urls.set(name, url);
    }
    return url;
  }

  async receive(
    queueName: string,
    options: { max: number; waitSeconds: number; visibilitySeconds: number; signal?: AbortSignal },
  ): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MaxNumberOfMessages: options.max,
        WaitTimeSeconds: options.waitSeconds,
        VisibilityTimeout: options.visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId', 'SentTimestamp'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: options.signal },
    );
    return response.Messages ?? [];
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: await this.queueUrl(queueName), ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(queueName: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.min(43_200, Math.round(seconds))),
      }),
    );
  }

  async send(queueName: string, message: Omit<FifoMessage, 'id'>): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
        MessageAttributes: toAttributes(message.attributes),
      }),
    );
  }

  /** Retorna os ids que o SQS aceitou. */
  async sendBatch(queueName: string, messages: FifoMessage[]): Promise<{ ok: string[]; failed: Map<string, string> }> {
    const response = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.queueUrl(queueName),
        Entries: messages.map((m, index) => ({
          Id: `m${index}`,
          MessageBody: m.body,
          MessageGroupId: m.groupId,
          MessageDeduplicationId: m.deduplicationId,
          MessageAttributes: toAttributes(m.attributes),
        })),
      }),
    );
    const byEntryId = new Map(messages.map((m, index) => [`m${index}`, m.id]));
    const ok = (response.Successful ?? []).map((s) => byEntryId.get(s.Id ?? '')).filter((id): id is string => !!id);
    const failed = new Map<string, string>();
    for (const f of response.Failed ?? []) {
      const id = byEntryId.get(f.Id ?? '');
      if (id) failed.set(id, `${f.Code ?? 'Unknown'}: ${f.Message ?? ''}`);
    }
    return { ok, failed };
  }

  async ping(queueName: string): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(queueName), AttributeNames: ['QueueArn'] }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}

function toAttributes(attributes: Record<string, string> | undefined) {
  if (!attributes) return undefined;
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
  );
}
