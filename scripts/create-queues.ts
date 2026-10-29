import 'reflect-metadata';
import { createSqsClient } from '../src/messaging/sqs-client';
import { ensureQueues } from '../src/messaging/ensure-queues';

async function main(): Promise<void> {
  const client = createSqsClient();
  try {
    await ensureQueues(client);
  } finally {
    client.destroy();
  }
}

void main();
