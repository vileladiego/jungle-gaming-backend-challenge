import { writeFileSync } from 'node:fs';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { createSqsClient } from '../src/messaging/sqs-client';
import { WAGER_DOMAIN_EVENTS_QUEUE } from '../src/messaging/queue-names';

const readyPath = process.env.CONSUMER_READY_PATH;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }
  const owner = new Client({ connectionString: databaseUrl });
  await owner.connect();
  const sqs = createSqsClient();
  const url = await sqs.send(new GetQueueUrlCommand({ QueueName: WAGER_DOMAIN_EVENTS_QUEUE }));
  if (url.QueueUrl === undefined) {
    throw new Error('Domain event queue URL is missing');
  }
  const queueUrl = url.QueueUrl;
  let running = true;
  const shutdown = (): void => {
    running = false;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  if (readyPath !== undefined && readyPath !== '') {
    writeFileSync(readyPath, String(process.pid));
  }
  while (running) {
    let response: ReceiveMessageCommandOutput;
    try {
      response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 10,
        }),
      );
    } catch {
      await sleep(200);
      continue;
    }
    for (const message of response.Messages ?? []) {
      if (!running) {
        break;
      }
      const receipt = message.ReceiptHandle;
      const eventId = readEventId(message.Body);
      if (receipt === undefined || eventId === undefined) {
        continue;
      }
      await owner.query(
        `insert into test_domain_event_effects (event_id, deliveries)
         values ($1, 1)
         on conflict (event_id) do update
           set deliveries = test_domain_event_effects.deliveries + 1`,
        [eventId],
      );
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
    }
  }
  sqs.destroy();
  await owner.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readEventId(body: string | undefined): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as { eventId?: unknown };
    return typeof parsed.eventId === 'string' && parsed.eventId !== '' ? parsed.eventId : undefined;
  } catch {
    return undefined;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'event consumer failed'}\n`);
  process.exit(1);
});
