import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { buildMikroOrmConfig } from '../src/persistence/mikro-orm.config';
import { ensureQueues } from '../src/messaging/ensure-queues';
import { createSqsClient } from '../src/messaging/sqs-client';
import { probeSqs } from '../src/messaging/sqs-probe';
import { probePostgres } from '../src/persistence/postgres-probe';
import {
  WAGER_DOMAIN_EVENTS_QUEUE,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../src/messaging/queue-names';

const FINANCIAL_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'ingress_rejects',
];

describe('Fase 1', () => {
  let orm: MikroORM | undefined;
  let app: INestApplication | undefined;
  let baseUrl: string;
  let sqs: SQSClient | undefined;

  beforeAll(async () => {
    orm = await MikroORM.init(buildMikroOrmConfig());
    sqs = createSqsClient();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('HTTP server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    sqs?.destroy();
    await orm?.close(true);
  });

  test('migration vazia sobe e desce sem tabela financeira', async () => {
    if (orm === undefined || sqs === undefined) {
      throw new Error('Infrastructure clients were not started');
    }
    const migrator = orm.migrator;
    await migrator.up();
    await expectNoFinancialSchema(orm);
    await migrator.down();
    await expectNoFinancialSchema(orm);
    await migrator.up();
  }, 30_000);

  test('filas FIFO, DLQ com maxReceiveCount 5 e visibility 60', async () => {
    if (sqs === undefined) {
      throw new Error('SQS client was not started');
    }
    await ensureQueues(sqs);
    const input = await queueAttributes(sqs, WAGER_TRANSACTIONS_QUEUE);
    const dlq = await queueAttributes(sqs, WAGER_TRANSACTIONS_DLQ);
    const output = await queueAttributes(sqs, WAGER_DOMAIN_EVENTS_QUEUE);

    expect(input.FifoQueue).toBe('true');
    expect(input.ContentBasedDeduplication).toBe('false');
    expect(input.VisibilityTimeout).toBe('60');
    const redrive = JSON.parse(input.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: number | string;
    };
    expect(redrive.deadLetterTargetArn).toBe(dlq.QueueArn);
    expect(String(redrive.maxReceiveCount)).toBe('5');
    expect(dlq.FifoQueue).toBe('true');
    expect(dlq.ContentBasedDeduplication).toBe('false');
    expect(dlq.RedrivePolicy).toBeUndefined();
    expect(output.FifoQueue).toBe('true');
    expect(output.ContentBasedDeduplication).toBe('false');
    expect(output.RedrivePolicy).toBeUndefined();
  }, 30_000);

  test('live responde 200 sem autenticação', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('ready responde 200 sem credencial no corpo', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain('4566');
    expect(text).not.toContain('SECRET');
    expect(JSON.parse(text)).toEqual({
      status: 'ok',
      postgres: 'up',
      sqs: 'up',
    });
  });

  test('Postgres inalcançável fica down', async () => {
    const broken = await MikroORM.init({
      ...buildMikroOrmConfig(),
      clientUrl: 'postgresql://wager:wager@127.0.0.1:1/wagering',
      connect: false,
      driverOptions: { connection: { connectionTimeoutMillis: 1000 } },
    });
    try {
      expect(await probePostgres(broken)).toBe('down');
    } finally {
      await broken.close(true);
    }
  });

  test('SQS inalcançável fica down', async () => {
    const closed = createSqsClient('http://127.0.0.1:9');
    try {
      expect(await probeSqs(closed)).toBe('down');
    } finally {
      closed.destroy();
    }
  });
});

async function expectNoFinancialSchema(orm: MikroORM): Promise<void> {
  const tables = await publicTables(orm);
  for (const name of FINANCIAL_TABLES) {
    expect(tables).not.toContain(name);
  }
  expect(await moneyColumns(orm)).toEqual([]);
}

async function publicTables(orm: MikroORM): Promise<string[]> {
  const rows = await orm.em.getConnection().execute<{ table_name: string }[]>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'`,
  );
  return rows.map((row) => row.table_name);
}

async function moneyColumns(orm: MikroORM): Promise<string[]> {
  const rows = await orm.em.getConnection().execute<{ column_name: string }[]>(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and (data_type in ('numeric', 'real', 'double precision')
          or column_name in ('balance_amount', 'amount'))`,
  );
  return rows.map((row) => row.column_name);
}

async function queueAttributes(
  client: SQSClient,
  name: string,
): Promise<Record<string, string>> {
  const url = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (url.QueueUrl === undefined) {
    throw new Error(`Missing URL for ${name}`);
  }
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url.QueueUrl,
      AttributeNames: ['All'],
    }),
  );
  return result.Attributes ?? {};
}
