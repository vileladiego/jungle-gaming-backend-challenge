import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { OutboxPublisher } from '../src/application/messaging/outbox-publisher';
import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  const flag = process.env.START_FLAG;
  if (flag === undefined || flag === '') {
    throw new Error('START_FLAG is required');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const publisher = app.get(OutboxPublisher);
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
  const deadline = Date.now() + 20_000;
  let released = false;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(flag, 'utf8') === 'go') {
        released = true;
        break;
      }
    } catch {
      // The parent creates the flag after every publisher has booted.
    }
    await sleep(20);
  }
  if (!released) {
    throw new Error('publisher was not released');
  }
  const shutdown = async (): Promise<void> => {
    await publisher.stop();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  await publisher.start();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'publisher failed'}\n`);
  process.exit(1);
});
