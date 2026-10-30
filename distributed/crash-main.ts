import 'reflect-metadata';
import { existsSync, writeFileSync } from 'node:fs';
import { GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { SubmitWagerService } from '../src/application/submit-wager.service';
import { parseWagerMessage } from '../src/application/messaging/wager-message';
import { FinancialStore } from '../src/persistence/financial-store';
import { createSqsClient } from '../src/messaging/sqs-client';
import { WAGER_DOMAIN_EVENTS_QUEUE, WAGER_TRANSACTIONS_QUEUE } from '../src/messaging/queue-names';
import { uuidV7 } from '../src/persistence/uuid-v7';
import { AppModule } from '../src/app.module';

const mode = process.env.CRASH_MODE;
const resultPath = process.env.CRASH_RESULT_PATH;

async function main(): Promise<void> {
  if (resultPath === undefined || resultPath === '') {
    throw new Error('CRASH_RESULT_PATH is required');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    if (mode === 'before-ack') {
      await commitWithoutAck(app.get(SubmitWagerService));
    } else if (mode === 'before-publish') {
      const claimed = await app.get(FinancialStore).claimOutbox();
      if (claimed === null) {
        throw new Error('No outbox event was available to claim');
      }
      writeFileSync(resultPath, JSON.stringify({ eventId: claimed.eventId }));
    } else if (mode === 'after-send') {
      const store = app.get(FinancialStore);
      const claimed = await store.claimOutbox();
      if (claimed === null) {
        throw new Error('No outbox event was available to send');
      }
      const sqs = createSqsClient();
      const url = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_DOMAIN_EVENTS_QUEUE }));
      const eventId = readEventId(claimed.body) ?? claimed.eventId;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: url.QueueUrl,
          MessageBody: claimed.body,
          MessageGroupId: claimed.aggregateId,
          MessageDeduplicationId: eventId,
        }),
      );
      sqs.destroy();
      writeFileSync(resultPath, JSON.stringify({ eventId: claimed.eventId }));
    } else {
      throw new Error(`Unknown CRASH_MODE ${mode ?? ''}`);
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  await sleep(30_000);
  process.exit(86);
}

async function commitWithoutAck(wagers: SubmitWagerService): Promise<void> {
  const sqs = createSqsClient();
  const url = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE }));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url.QueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 2,
      }),
    );
    const body = response.Messages?.[0]?.Body;
    if (body === undefined) {
      continue;
    }
    const parsed = parseWagerMessage(JSON.parse(body) as unknown);
    if (!parsed.ok) {
      throw new Error(`Crash harness received an invalid wager: ${parsed.failureCode}`);
    }
    const wager = parsed.message;
    await wagers.submitFromQueue({
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
    writeFileSync(resultPath ?? '', JSON.stringify({ committed: true, messageId: wager.messageId }));
    sqs.destroy();
    return;
  }
  sqs.destroy();
  throw new Error('No wager message arrived before the crash harness gave up');
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

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'crash harness failed';
  if (resultPath !== undefined && resultPath !== '' && !existsSync(resultPath)) {
    writeFileSync(resultPath, JSON.stringify({ error: message }));
  }
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
