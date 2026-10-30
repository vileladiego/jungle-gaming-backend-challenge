import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { pollIntervalMs } from '../../config/async-config';
import { DomainError } from '../../domain/domain-error';
import { SQS_CLIENT } from '../../messaging/messaging.module';
import { INPUT_VISIBILITY_TIMEOUT_SECONDS, WAGER_TRANSACTIONS_DLQ, WAGER_TRANSACTIONS_QUEUE } from '../../messaging/queue-names';
import { classifyPostgresError } from '../../persistence/postgres-error';
import { FinancialStore, type SubmitWagerPersistenceResult } from '../../persistence/financial-store';
import { uuidV7 } from '../../persistence/uuid-v7';
import type { ProviderIdentityPort } from '../provider-identity.port';
import { SubmitWagerService } from '../submit-wager.service';
import { logJson } from './json-log';
import { ProcessingMetrics } from './processing-metrics';
import { parseWagerMessage } from './wager-message';

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

@Injectable()
export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private inputUrl: string | undefined;
  private dlqUrl: string | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SubmitWagerService) private readonly wagers: SubmitWagerService,
    @Inject(FinancialStore) private readonly store: FinancialStore,
    @Inject(ProcessingMetrics) private readonly metrics: ProcessingMetrics,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  start(): Promise<void> {
    if (this.running && this.loop !== undefined) {
      return this.loop;
    }
    this.running = true;
    this.loop = this.poll();
    return this.loop;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.queueUrl(WAGER_TRANSACTIONS_QUEUE, 'input'),
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: receiveWaitSeconds(),
            VisibilityTimeout: INPUT_VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
          }),
        );
        const messages = response.Messages ?? [];
        if (messages.length === 0) {
          await sleep(pollIntervalMs());
          continue;
        }
        const groups = groupMessages(messages);
        await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
      } catch (error) {
        this.metrics.markRetry();
        logJson('error', 'sqs receive failed', { failureCode: errorName(error) });
        await sleep(pollIntervalMs());
      }
    }
  }

  private async handleGroup(messages: Message[]): Promise<void> {
    for (const message of messages) {
      if (!this.running && message.ReceiptHandle !== undefined) {
        await this.returnVisibility(message.ReceiptHandle);
        continue;
      }
      await this.handle(message);
    }
  }

  private async handle(message: Message): Promise<void> {
    const started = Date.now();
    const receipt = message.ReceiptHandle;
    const sqsMessageId = message.MessageId ?? 'missing-sqs-id';
    if (receipt === undefined) {
      return;
    }
    let ack = false;
    try {
      ack = await this.decide(message, sqsMessageId);
    } catch (error) {
      this.noteFailure(error);
      logJson('warn', 'wager message was not committed', {
        messageId: sqsMessageId,
        failureCode: errorName(error),
      });
    } finally {
      this.metrics.markLatency(Date.now() - started);
    }
    if (ack) {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: await this.queueUrl(WAGER_TRANSACTIONS_QUEUE, 'input'),
          ReceiptHandle: receipt,
        }),
      );
      return;
    }
    if (!this.running) {
      await this.returnVisibility(receipt);
    }
  }

  private async decide(message: Message, sqsMessageId: string): Promise<boolean> {
    const body = parseBody(message.Body);
    const parsed = parseWagerMessage(body, this.identity.current());
    if (!parsed.ok) {
      await this.poison(parsed.messageId === 'unparsed' ? sqsMessageId : parsed.messageId, parsed.failureCode, null, message.Body);
      return true;
    }
    const wager = parsed.message;
    try {
      const result = await this.wagers.submitFromQueue({
        id: uuidV7(),
        providerId: wager.providerId,
        externalTransactionId: wager.externalTransactionId,
        idempotencyKey: wager.idempotencyKey,
        walletId: wager.walletId,
        playerId: wager.playerId,
        roundId: wager.roundId,
        gameId: wager.gameId,
        kind: wager.kind,
        amount: wager.amount,
        currency: wager.currency,
        referenceExternalTransactionId: wager.referenceExternalTransactionId,
        now: wager.occurredAt,
        correlationId: uuidV7(),
        inbox: { messageId: wager.messageId, payloadHash: wager.payloadHash },
      });
      return this.afterCommit(result, wager.messageId, wager.walletId, wager.providerId, message.Body);
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.failureCode === 'INVALID_PAYLOAD' || error.failureCode === 'REFERENCE_REQUIRED')
      ) {
        await this.poison(wager.messageId, error.failureCode, wager.payloadHash, message.Body);
        return true;
      }
      throw error;
    }
  }

  private async afterCommit(
    result: SubmitWagerPersistenceResult,
    messageId: string,
    walletId: string,
    providerId: string,
    body: string | undefined,
  ): Promise<boolean> {
    if (result.outcome === 'inbox-held') {
      logJson('info', 'inbox row is not committed yet', { messageId, walletId, providerId });
      return false;
    }
    if (result.outcome === 'duplicate' || result.inbox === 'duplicate' || result.outcome === 'replay') {
      this.metrics.markDuplicate();
    }
    if (result.outcome === 'conflict' && result.inbox === 'mismatch') {
      await this.sendToDlq(messageId, body);
      this.metrics.markDlq();
      logJson('warn', 'conflicting inbox payload sent to dlq', { messageId, walletId, providerId, failureCode: result.failureCode });
      return true;
    }
    if (result.outcome === 'conflict') {
      this.metrics.markTransaction(result.failureCode);
      logJson('info', 'wager message conflict acknowledged', {
        messageId,
        walletId,
        providerId,
        failureCode: result.failureCode,
      });
      return true;
    }
    if (result.outcome === 'duplicate') {
      logJson('info', 'duplicate wager message acknowledged', { messageId, walletId, providerId });
      return true;
    }
    this.metrics.markTransaction(result.transaction.status);
    logJson('info', 'wager message committed', {
      messageId,
      transactionId: result.transaction.id,
      walletId,
      providerId,
      correlationId: result.transaction.id,
      status: result.transaction.status,
      failureCode: result.transaction.failureCode,
    });
    return true;
  }

  private async poison(
    messageId: string,
    failureCode: string,
    payloadHash: string | null,
    body: string | undefined,
  ): Promise<void> {
    await this.store.recordIngressReject(messageId, failureCode, payloadHash);
    await this.sendToDlq(messageId, body);
    this.metrics.markDlq();
    logJson('warn', 'invalid wager message sent to dlq', { messageId, failureCode });
  }

  private async sendToDlq(messageId: string, body: string | undefined): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(WAGER_TRANSACTIONS_DLQ, 'dlq'),
        MessageBody: body ?? '{}',
        MessageGroupId: messageId.slice(0, 128),
        MessageDeduplicationId: `dlq:${messageId}`.slice(0, 128),
      }),
    );
  }

  private noteFailure(error: unknown): void {
    const classified = classifyPostgresError(error);
    if (classified.kind === 'transient' && classified.code === '55P03') {
      this.metrics.markLockConflict();
      return;
    }
    this.metrics.markRetry();
  }

  private async returnVisibility(receipt: string): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(WAGER_TRANSACTIONS_QUEUE, 'input'),
        ReceiptHandle: receipt,
        VisibilityTimeout: 0,
      }),
    );
  }

  private async queueUrl(name: string, slot: 'input' | 'dlq'): Promise<string> {
    const cached = slot === 'input' ? this.inputUrl : this.dlqUrl;
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (response.QueueUrl === undefined) {
      throw new Error(`Queue URL missing for ${name}`);
    }
    if (slot === 'input') {
      this.inputUrl = response.QueueUrl;
    } else {
      this.dlqUrl = response.QueueUrl;
    }
    return response.QueueUrl;
  }
}

function groupMessages(messages: Message[]): Map<string, Message[]> {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'ungrouped';
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  return groups;
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined || body.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function receiveWaitSeconds(): number {
  return Math.min(20, Math.max(0, Math.floor(pollIntervalMs() / 1000)));
}

function errorName(error: unknown): string {
  if (error instanceof DomainError) {
    return error.failureCode;
  }
  const classified = classifyPostgresError(error);
  if (classified.kind === 'transient') {
    return classified.code;
  }
  return error instanceof Error ? error.name : 'Error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
