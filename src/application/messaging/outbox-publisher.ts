import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { pollIntervalMs } from '../../config/async-config';
import { SQS_CLIENT } from '../../messaging/messaging.module';
import { WAGER_DOMAIN_EVENTS_QUEUE } from '../../messaging/queue-names';
import { FinancialStore } from '../../persistence/financial-store';
import { logJson } from './json-log';
import { ProcessingMetrics } from './processing-metrics';

@Injectable()
export class OutboxPublisher {
  private running = false;
  private loop: Promise<void> | undefined;
  private queueUrl: string | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(FinancialStore) private readonly store: FinancialStore,
    @Inject(ProcessingMetrics) private readonly metrics: ProcessingMetrics,
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

  async publishAvailable(): Promise<number> {
    let published = 0;
    while (await this.publishOne()) {
      published += 1;
    }
    await this.sampleLag();
    return published;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.publishOne();
        await this.sampleLag();
        if (!published) {
          await sleep(pollIntervalMs());
        }
      } catch (error) {
        this.metrics.markRetry();
        logJson('error', 'outbox publish failed', {
          failureCode: error instanceof Error ? error.name : 'Error',
        });
        await sleep(pollIntervalMs());
      }
    }
  }

  private async publishOne(): Promise<boolean> {
    const claimed = await this.store.claimOutbox();
    if (claimed === null) {
      return false;
    }
    const eventId = readEventId(claimed.body) ?? claimed.eventId;
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: await this.domainQueue(),
          MessageBody: claimed.body,
          MessageGroupId: claimed.aggregateId,
          MessageDeduplicationId: eventId,
        }),
      );
    } catch (error) {
      await this.store.rescheduleOutbox(claimed.eventId);
      this.metrics.markRetry();
      logJson('warn', 'outbox send rescheduled', {
        eventId: claimed.eventId,
        walletId: claimed.aggregateId,
        failureCode: error instanceof Error ? error.name : 'Error',
      });
      return true;
    }
    await this.store.markOutboxPublished(claimed.eventId);
    logJson('info', 'outbox event published', {
      eventId: claimed.eventId,
      walletId: claimed.aggregateId,
    });
    return true;
  }

  private async sampleLag(): Promise<void> {
    const lag = await this.store.readOutboxLag();
    this.metrics.setOutboxLag(lag.count, lag.lagSeconds);
  }

  private async domainQueue(): Promise<string> {
    if (this.queueUrl !== undefined) {
      return this.queueUrl;
    }
    const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_DOMAIN_EVENTS_QUEUE }));
    if (response.QueueUrl === undefined) {
      throw new Error(`Queue URL missing for ${WAGER_DOMAIN_EVENTS_QUEUE}`);
    }
    this.queueUrl = response.QueueUrl;
    return response.QueueUrl;
  }
}

function readEventId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { eventId?: unknown };
    return typeof parsed.eventId === 'string' && parsed.eventId !== '' ? parsed.eventId : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
