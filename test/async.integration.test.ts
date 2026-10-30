import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { OutboxPublisher } from '../src/application/messaging/outbox-publisher';
import { PendingReferenceWorker } from '../src/application/messaging/pending-reference-worker';
import { ProcessingMetrics } from '../src/application/messaging/processing-metrics';
import { SqsWagerConsumer } from '../src/application/messaging/sqs-wager-consumer';
import { createSqsClient } from '../src/messaging/sqs-client';
import { ensureQueues } from '../src/messaging/ensure-queues';
import {
  WAGER_DOMAIN_EVENTS_QUEUE,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../src/messaging/queue-names';
import { SubmitWagerService } from '../src/application/submit-wager.service';
import { parseWagerMessage } from '../src/application/messaging/wager-message';
import { Money } from '../src/domain/money/money';
import { HealthService } from '../src/health/health.service';
import { FinancialStore } from '../src/persistence/financial-store';
import { buildMigrationMikroOrmConfig } from '../src/persistence/mikro-orm.config';
import { uuidV7 } from '../src/persistence/uuid-v7';
import { holdSchemaLock } from './support/database-lock';

describe('Fase 4B', () => {
  let release: (() => Promise<void>) | undefined;
  let owner: MikroORM | undefined;
  let app: INestApplicationContext | undefined;
  let sqs: SQSClient | undefined;
  let ownerClient: Client | undefined;
  let store: FinancialStore | undefined;
  let consumer: SqsWagerConsumer | undefined;
  let publisher: OutboxPublisher | undefined;
  let worker: PendingReferenceWorker | undefined;
  let metrics: ProcessingMetrics | undefined;
  const queues = new Map<string, string>();

  beforeAll(async () => {
    process.env.CLAIM_LEASE_MS = '100';
    process.env.PENDING_MAX_ATTEMPTS = '3';
    process.env.PENDING_BACKOFF_BASE_MS = '50';
    process.env.PENDING_BACKOFF_CAP_MS = '200';
    process.env.OUTBOX_BACKOFF_BASE_MS = '50';
    process.env.OUTBOX_BACKOFF_CAP_MS = '200';
    process.env.POLL_INTERVAL_MS = '50';
    release = await holdSchemaLock();
    owner = await MikroORM.init(buildMigrationMikroOrmConfig());
    await owner.migrator.up();
    sqs = createSqsClient();
    await ensureQueues(sqs);
    for (const name of [WAGER_TRANSACTIONS_QUEUE, WAGER_TRANSACTIONS_DLQ, WAGER_DOMAIN_EVENTS_QUEUE]) {
      const url = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      if (url.QueueUrl === undefined) {
        throw new Error(`Queue URL missing for ${name}`);
      }
      queues.set(name, url.QueueUrl);
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url.QueueUrl })).catch(() => undefined);
    }
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    ownerClient = new Client({ connectionString: process.env.DATABASE_URL });
    await ownerClient.connect();
    await ownerClient.query(
      `truncate table wallet_ledger_entries, wager_transactions, inbox_messages, outbox_messages, ingress_rejects, wallets`,
    );
    store = app.get(FinancialStore);
    consumer = app.get(SqsWagerConsumer);
    publisher = app.get(OutboxPublisher);
    worker = app.get(PendingReferenceWorker);
    metrics = app.get(ProcessingMetrics);
  }, 120_000);

  afterAll(async () => {
    await consumer?.stop();
    await publisher?.stop();
    await worker?.stop();
    await app?.close();
    sqs?.destroy();
    await ownerClient?.end();
    await owner?.close(true);
    await release?.();
  });

  test('ready continua sem credencial', async () => {
    const report = await app?.get(HealthService).ready();
    expect(report?.status).toBe('ok');
    expect(report?.postgres).toBe('up');
    expect(report?.sqs).toBe('up');
    expect(JSON.stringify(report)).not.toContain('wager_app');
  });

  test('mensagem duplicada não debita de novo e payload divergente vai à DLQ', async () => {
    const walletId = await openWallet('player-dup-sqs', '100.00');
    await sendWager(walletId, 'player-dup-sqs', 'dup-bet', 'BET', '30.00', 'dup-1');
    await sendWager(walletId, 'player-dup-sqs', 'dup-bet', 'BET', '30.00', 'dup-2');
    await runConsumer();
    expect(await balance(walletId)).toBe('70.00');
    expect(await count(`select count(*)::text as count from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT' and amount = 30.00`, [walletId])).toBe('1');
    expect(await count(`select count(*)::text as count from inbox_messages where message_id = $1`, ['msg-dup-bet'])).toBe('1');
    expect(metrics?.duplicates).toBeGreaterThan(0);
    await expectLedger(walletId);

    const duplicatesBefore = metrics?.duplicates ?? 0;
    await sendWager(walletId, 'player-dup-sqs', 'dup-bet', 'BET', '31.00', 'dup-3');
    await runConsumer();
    expect(await balance(walletId)).toBe('70.00');
    expect(metrics?.duplicates).toBe(duplicatesBefore);
    expect(metrics?.dlq).toBeGreaterThan(0);
    const poison = await receive(WAGER_TRANSACTIONS_DLQ, 3);
    expect(poison?.Body).toContain('msg-dup-bet');
    expect(await count(`select count(*)::text as count from ingress_rejects where message_id = $1`, ['msg-dup-bet'])).toBe('1');
    await expectLedger(walletId);
  }, 20_000);

  test('referência fora de ordem é resolvida quando a aposta chega', async () => {
    const walletId = await openWallet('player-order-sqs', '100.00');
    await sendWager(walletId, 'player-order-sqs', 'order-refund', 'REFUND', '25.00', 'order-r', 'order-bet');
    await runConsumer();
    expect(await statusOf('order-refund')).toBe('PENDING_REFERENCE');
    expect(await balance(walletId)).toBe('100.00');
    const schedule = await scheduleOf('order-refund');
    await sendWager(walletId, 'player-order-sqs', 'order-refund', 'REFUND', '25.00', 'order-r2', 'order-bet');
    await runConsumer();
    const replayed = await scheduleOf('order-refund');
    expect(replayed.attemptCount).toBe(schedule.attemptCount);
    expect(replayed.deadline).toBe(schedule.deadline);
    await sendWager(walletId, 'player-order-sqs', 'order-bet', 'BET', '25.00', 'order-b');
    await runConsumer();
    expect(await statusOf('order-bet')).toBe('PROCESSED');
    await settle('order-refund');
    expect(await statusOf('order-refund')).toBe('PROCESSED');
    expect(await balance(walletId)).toBe('100.00');
    await publishAll();
    const events = await drain(WAGER_DOMAIN_EVENTS_QUEUE, 30);
    expect(events.some((body) => body.includes('WagerTransactionPendingReference'))).toBe(true);
    expect(events.some((body) => body.includes('WagerTransactionProcessed'))).toBe(true);
    await expectLedger(walletId);
  }, 20_000);

  test('referência ausente esgota tentativas ou o prazo e rejeita', async () => {
    const walletId = await openWallet('player-missing-sqs', '100.00');
    await sendWager(walletId, 'player-missing-sqs', 'missing-refund', 'REFUND', '10.00', 'missing-1', 'never-bet');
    await runConsumer();
    await settle('missing-refund');
    expect(await statusOf('missing-refund')).toBe('REJECTED');
    expect(await failureOf('missing-refund')).toBe('REFERENCE_NOT_FOUND');
    expect(await balance(walletId)).toBe('100.00');
    expect(Number(await scalar(`select attempt_count::text as value from wager_transactions where external_transaction_id = $1`, ['missing-refund']))).toBe(3);

    await sendWager(walletId, 'player-missing-sqs', 'deadline-refund', 'REFUND', '10.00', 'deadline-1', 'also-never');
    await runConsumer();
    const attempts = await scalar(`select attempt_count::text as value from wager_transactions where external_transaction_id = $1`, ['deadline-refund']);
    await ownerSql(
      `update wager_transactions
          set deadline_at = now() - interval '1 second',
              next_attempt_at = now() - interval '1 second'
        where external_transaction_id = $1`,
      ['deadline-refund'],
    );
    expect(await worker?.once()).toBe(true);
    expect(await statusOf('deadline-refund')).toBe('REJECTED');
    expect(await failureOf('deadline-refund')).toBe('REFERENCE_NOT_FOUND');
    expect(await scalar(`select attempt_count::text as value from wager_transactions where external_transaction_id = $1`, ['deadline-refund'])).toBe(attempts);
    await publishAll();
    const rejected = await drain(WAGER_DOMAIN_EVENTS_QUEUE, 30);
    expect(rejected.some((body) => body.includes('WagerTransactionRejected') && body.includes('REFERENCE_NOT_FOUND'))).toBe(true);
    await expectLedger(walletId);
  }, 20_000);

  test('falha transitória não confirma e o crash antes do ack não duplica', async () => {
    const walletId = await openWallet('player-retry-sqs', '100.00');
    const held = requireOwner();
    await held.query('begin');
    await held.query('select id from wallets where id = $1 for update', [walletId]);
    await sendWager(walletId, 'player-retry-sqs', 'locked-bet', 'BET', '10.00', 'locked-1');
    const running = consumer?.start();
    await sleep(400);
    await consumer?.stop();
    await running;
    expect(await count(`select count(*)::text as count from wager_transactions where external_transaction_id = $1`, ['locked-bet'])).toBe('0');
    expect((await receive(WAGER_TRANSACTIONS_DLQ, 1))?.Body).toBeUndefined();
    await held.query('rollback');
    const returned = await receive(WAGER_TRANSACTIONS_QUEUE, 3);
    expect(returned?.Body).toContain('locked-bet');
    await deleteMessage(WAGER_TRANSACTIONS_QUEUE, returned);

    const crash = validEnvelope(walletId, 'player-retry-sqs', 'crash-bet', 'BET', '15.00');
    await sendRaw(JSON.stringify(crash), 'crash-1', walletId);
    const parsed = parseWagerMessage(crash);
    if (!parsed.ok) {
      throw new Error('Crash envelope was rejected');
    }
    await store?.submitWager({
      id: uuidV7(),
      providerId: parsed.message.providerId,
      externalTransactionId: parsed.message.externalTransactionId,
      idempotencyKey: parsed.message.idempotencyKey,
      walletId,
      playerId: parsed.message.playerId,
      roundId: parsed.message.roundId,
      gameId: parsed.message.gameId,
      kind: parsed.message.kind,
      amount: parsed.message.amount,
      currency: parsed.message.currency,
      now: parsed.message.occurredAt,
      correlationId: uuidV7(),
      inbox: { messageId: parsed.message.messageId, payloadHash: parsed.message.payloadHash },
    });
    await runConsumer();
    expect(await balance(walletId)).toBe('85.00');
    expect(await count(`select count(*)::text as count from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT' and amount = 15.00`, [walletId])).toBe('1');
    await expectLedger(walletId);
  }, 20_000);

  test('outbox sobrevive a crash, backoff e dois publishers', async () => {
    const walletId = await openWallet('player-outbox-sqs', '100.00');
    await publishAll();
    await drain(WAGER_DOMAIN_EVENTS_QUEUE, 40);
    await store?.submitWager(commandFrom(walletId, 'player-outbox-sqs', 'loss-once', 'LOSS', '5.00'));
    const claimed = await store?.claimOutbox();
    if (claimed === undefined || claimed === null) {
      throw new Error('Outbox claim returned nothing');
    }
    await sqs?.send(
      new SendMessageCommand({
        QueueUrl: queues.get(WAGER_DOMAIN_EVENTS_QUEUE),
        MessageBody: claimed.body,
        MessageGroupId: claimed.aggregateId,
        MessageDeduplicationId: claimed.eventId,
      }),
    );
    await ownerSql(`update outbox_messages set next_attempt_at = now() - interval '1 second' where id = $1`, [claimed.eventId]);
    await publishAll();
    const published = await receive(WAGER_DOMAIN_EVENTS_QUEUE, 3);
    expect(published?.Body).toContain(claimed.eventId);
    await deleteMessage(WAGER_DOMAIN_EVENTS_QUEUE, published);
    expect(await scalar(`select published_at::text as value from outbox_messages where id = $1`, [claimed.eventId])).not.toBe('');
    expect(await count(`select count(*)::text as count from outbox_messages where id = $1`, [claimed.eventId])).toBe('1');

    await store?.submitWager(commandFrom(walletId, 'player-outbox-sqs', 'loss-backoff', 'LOSS', '5.00'));
    const leased = await store?.claimOutbox();
    if (leased === undefined || leased === null) {
      throw new Error('Backoff claim returned nothing');
    }
    await store?.rescheduleOutbox(leased.eventId);
    await sleep(80);
    const second = app?.get(OutboxPublisher);
    expect(await second?.publishAvailable()).toBe(1);
    expect(await scalar(`select published_at::text as value from outbox_messages where id = $1`, [leased.eventId])).not.toBe('');
    await drain(WAGER_DOMAIN_EVENTS_QUEUE, 10);

    await store?.submitWager(commandFrom(walletId, 'player-outbox-sqs', 'loss-race', 'LOSS', '5.00'));
    const [left, right] = await Promise.all([publisher?.publishAvailable(), second?.publishAvailable()]);
    expect((left ?? 0) + (right ?? 0)).toBe(1);
    expect(await count(`select count(*)::text as count from outbox_messages where published_at is null`, [])).toBe('0');
    const raced = await drain(WAGER_DOMAIN_EVENTS_QUEUE, 3);
    expect(raced).toHaveLength(1);
    await expectLedger(walletId);
    expect(metrics?.outboxLagCount).toBe(0);
  }, 20_000);

  test('payload inválido vai à DLQ na primeira leitura e duas wallets andam em paralelo', async () => {
    await sendRaw(JSON.stringify({ messageId: 'not-json', type: 'Nope' }), 'bad-1', 'wallet-group');
    const opening = validEnvelope('00000000-0000-7000-8000-000000000099', 'player-opening', 'open-ext', 'BET', '1.00');
    opening.data.kind = 'OPENING';
    await sendRaw(JSON.stringify(opening), 'bad-2', '00000000-0000-7000-8000-000000000099');
    await runConsumer();
    const dlq = await drain(WAGER_TRANSACTIONS_DLQ, 4);
    expect(dlq.length).toBeGreaterThanOrEqual(2);
    expect(await count(`select count(*)::text as count from wager_transactions where external_transaction_id = $1`, ['open-ext'])).toBe('0');
    expect(await count(`select count(*)::text as count from ingress_rejects where message_id in ('not-json', 'msg-open-ext')`, [])).toBe('2');

    const left = await openWallet('player-par-a', '50.00');
    const right = await openWallet('player-par-b', '80.00');
    await sendWager(left, 'player-par-a', 'par-a', 'BET', '20.00', 'par-a');
    await sendWager(right, 'player-par-b', 'par-b', 'BET', '30.00', 'par-b');
    await runConsumer();
    expect(await balance(left)).toBe('30.00');
    expect(await balance(right)).toBe('50.00');
    await expectLedger(left);
    await expectLedger(right);
  }, 20_000);

  test('SQS inacessível incrementa retry e o processo continua', async () => {
    const bad = createSqsClient('http://127.0.0.1:1');
    const isolated = new ProcessingMetrics();
    const failing = new SqsWagerConsumer(bad, app!.get(SubmitWagerService), store!, isolated, {
      current: () => undefined,
    });
    const running = failing.start();
    await sleep(250);
    await failing.stop();
    await running;
    expect(isolated.retries).toBeGreaterThan(0);
    bad.destroy();
  }, 15_000);

  async function openWallet(playerId: string, amount: string): Promise<string> {
    const created = await store?.openWallet({
      id: uuidV7(),
      playerId,
      amount,
      currency: 'BRL',
      now: new Date(),
      correlationId: uuidV7(),
    });
    if (created?.outcome !== 'created') {
      throw new Error('Wallet was not created');
    }
    return created.wallet.id;
  }

  async function runConsumer(): Promise<void> {
    const running = consumer?.start();
    await sleep(350);
    await consumer?.stop();
    await running;
  }

  async function publishAll(): Promise<void> {
    await publisher?.publishAvailable();
  }

  async function settle(external: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await worker?.once();
      if ((await statusOf(external)) !== 'PENDING_REFERENCE') {
        return;
      }
      await sleep(40);
    }
    throw new Error(`Reference ${external} stayed pending`);
  }

  async function sendWager(
    walletId: string,
    playerId: string,
    external: string,
    kind: string,
    amount: string,
    dedup: string,
    reference?: string,
  ): Promise<void> {
    const message = validEnvelope(walletId, playerId, external, kind, amount, reference);
    await sendRaw(JSON.stringify(message), dedup, walletId);
  }

  async function sendRaw(body: string, dedup: string, group: string): Promise<void> {
    await sqs?.send(
      new SendMessageCommand({
        QueueUrl: queues.get(WAGER_TRANSACTIONS_QUEUE),
        MessageBody: body,
        MessageGroupId: group,
        MessageDeduplicationId: dedup,
      }),
    );
  }

  async function receive(queue: string, waitSeconds: number): Promise<Message | undefined> {
    const response = await sqs?.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.get(queue),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitSeconds,
      }),
    );
    return response?.Messages?.[0];
  }

  async function drain(queue: string, times: number): Promise<string[]> {
    const bodies: string[] = [];
    for (let index = 0; index < times; index += 1) {
      const message = await receive(queue, 1);
      if (message === undefined) {
        break;
      }
      if (message.Body !== undefined) {
        bodies.push(message.Body);
      }
      await deleteMessage(queue, message);
    }
    return bodies;
  }

  async function deleteMessage(queue: string, message: Message | undefined): Promise<void> {
    if (message?.ReceiptHandle === undefined) {
      return;
    }
    const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
    await sqs?.send(
      new DeleteMessageCommand({
        QueueUrl: queues.get(queue),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  function commandFrom(walletId: string, playerId: string, external: string, kind: 'BET' | 'LOSS', amount: string) {
    return {
      id: uuidV7(),
      providerId: 'prov',
      externalTransactionId: external,
      idempotencyKey: `prov:${external}`,
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      amount,
      currency: 'BRL',
      now: new Date('2026-10-29T15:00:00.000Z'),
      correlationId: uuidV7(),
    };
  }

  async function balance(walletId: string): Promise<string> {
    return scalar(`select balance_amount::text as value from wallets where id = $1`, [walletId]);
  }

  async function statusOf(external: string): Promise<string> {
    return scalar(`select status as value from wager_transactions where external_transaction_id = $1`, [external]);
  }

  async function failureOf(external: string): Promise<string> {
    return scalar(`select failure_code as value from wager_transactions where external_transaction_id = $1`, [external]);
  }

  async function scheduleOf(external: string): Promise<{ attemptCount: string; deadline: string }> {
    const rows = await ownerRows<{ attempt_count: string; deadline_at: string }>(
      `select attempt_count::text as attempt_count, deadline_at::text as deadline_at
         from wager_transactions where external_transaction_id = $1`,
      [external],
    );
    return { attemptCount: rows[0]?.attempt_count ?? '', deadline: rows[0]?.deadline_at ?? '' };
  }

  async function expectLedger(walletId: string): Promise<void> {
    const stored = await balance(walletId);
    const rows = await ownerRows<{
      direction: string;
      amount: string;
      balance_before: string;
      balance_after: string;
    }>(
      `select direction,
              amount::text as amount,
              balance_before::text as balance_before,
              balance_after::text as balance_after
         from wallet_ledger_entries
        where wallet_id = $1
        order by id`,
      [walletId],
    );
    let previous = '0.00';
    for (const row of rows) {
      expect(row.balance_before).toBe(previous);
      const before = Money.from({ amount: row.balance_before, currency: 'BRL' });
      const amount = Money.from({ amount: row.amount, currency: 'BRL' });
      const after = row.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
      expect(row.balance_after).toBe(after.toJSON().amount);
      previous = row.balance_after;
    }
    expect(previous).toBe(stored);
  }

  function requireOwner(): Client {
    if (ownerClient === undefined) {
      throw new Error('Owner client was not started');
    }
    return ownerClient;
  }

  async function ownerSql(sql: string, params: unknown[]): Promise<void> {
    await requireOwner().query(sql, params);
  }

  async function ownerRows<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await requireOwner().query<T>(sql, params);
    return result.rows;
  }

  async function scalar(sql: string, params: unknown[]): Promise<string> {
    const rows = await ownerRows<{ value: string | null }>(sql, params);
    return rows[0]?.value ?? '';
  }

  async function count(sql: string, params: unknown[]): Promise<string> {
    const rows = await ownerRows<{ count: string }>(sql, params);
    return rows[0]?.count ?? '0';
  }
});

function validEnvelope(walletId: string, playerId: string, external: string, kind: string, amount: string, reference?: string) {
  return {
    messageId: `msg-${external}`,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-29T15:00:00.000Z',
    data: {
      providerId: 'prov',
      externalTransactionId: external,
      idempotencyKey: `prov:${external}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
