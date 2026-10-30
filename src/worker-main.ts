import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { OutboxPublisher } from './application/messaging/outbox-publisher';
import { PendingReferenceWorker } from './application/messaging/pending-reference-worker';
import { SqsWagerConsumer } from './application/messaging/sqs-wager-consumer';
import { logJson } from './application/messaging/json-log';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const consumer = app.get(SqsWagerConsumer);
  const publisher = app.get(OutboxPublisher);
  const pending = app.get(PendingReferenceWorker);
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await Promise.all([consumer.stop(), publisher.stop(), pending.stop()]);
    await app.close();
  };
  process.once('SIGTERM', () => {
    void shutdown().then(() => {
      process.exit(0);
    });
  });
  process.once('SIGINT', () => {
    void shutdown().then(() => {
      process.exit(0);
    });
  });
  logJson('info', 'async workers started');
  await Promise.all([consumer.start(), publisher.start(), pending.start()]);
}

void bootstrap();
