import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { Money } from '../src/domain/money/money';
import {
  WAGER_DOMAIN_EVENTS_QUEUE,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from '../src/messaging/queue-names';
import { sleep } from './process-registry';

const QUEUES = [WAGER_TRANSACTIONS_QUEUE, WAGER_TRANSACTIONS_DLQ, WAGER_DOMAIN_EVENTS_QUEUE];

export function runtimeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAIM_LEASE_MS: '200',
    PENDING_MAX_ATTEMPTS: '8',
    PENDING_BACKOFF_BASE_MS: '50',
    PENDING_BACKOFF_CAP_MS: '200',
    OUTBOX_BACKOFF_BASE_MS: '50',
    OUTBOX_BACKOFF_CAP_MS: '200',
    POLL_INTERVAL_MS: '50',
    ...extra,
  };
}

export async function connectOwner(): Promise<Client> {
  const client = new Client({
    connectionString: required('DATABASE_URL'),
    connectionTimeoutMillis: 3_000,
  });
  await client.connect();
  return client;
}

export async function truncateFinancial(owner: Client): Promise<void> {
  await owner.query(
    `truncate table wallet_ledger_entries, wager_transactions, inbox_messages, outbox_messages, ingress_rejects, wallets`,
  );
}

export async function ensureEffectTable(owner: Client): Promise<void> {
  await owner.query(`drop table if exists test_domain_event_effects`);
  await owner.query(
    `create table test_domain_event_effects (
       event_id text primary key,
       deliveries integer not null check (deliveries > 0),
       first_received_at timestamptz not null default now()
     )`,
  );
}

export async function dropEffectTable(owner: Client): Promise<void> {
  await owner.query(`drop table if exists test_domain_event_effects`);
}

export async function prepareQueues(sqs: SQSClient): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const name of QUEUES) {
    const response = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (response.QueueUrl === undefined) {
      throw new Error(`Queue URL missing for ${name}`);
    }
    urls.set(name, response.QueueUrl);
    await sqs.send(new PurgeQueueCommand({ QueueUrl: response.QueueUrl })).catch(() => undefined);
  }
  return urls;
}

export async function sendQueueMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: string,
  groupId: string,
  dedupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId.slice(0, 128),
      MessageDeduplicationId: dedupId.slice(0, 128),
    }),
  );
}

export function wagerEnvelope(
  walletId: string,
  playerId: string,
  external: string,
  kind: string,
  amount: string,
  reference?: string,
): string {
  return JSON.stringify({
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
  });
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function waitForLive(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = 'not-started';
  while (Date.now() < deadline) {
    try {
      const response = await httpRequest(port, 'GET', '/health/live');
      if (response.status === 200) {
        return;
      }
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : 'connection refused';
    }
    await sleep(100);
  }
  throw new Error(`HTTP ${port} did not become ready (${last})`);
}

export async function openWallet(port: number, playerId: string, amount: string): Promise<string> {
  const created = await httpRequest(port, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  if (created.status !== 201 || typeof created.body.id !== 'string') {
    throw new Error(`Wallet open failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  return created.body.id;
}

export async function postWager(
  port: number,
  walletId: string,
  playerId: string,
  external: string,
  kind: string,
  amount: string,
  reference?: string,
): Promise<HttpResult> {
  let last: HttpResult = { status: 0, body: {} };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await httpRequest(
      port,
      'POST',
      '/wagering/transactions',
      {
        providerId: 'prov',
        externalTransactionId: external,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind,
        money: { amount, currency: 'BRL' },
        ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
      },
      { 'idempotency-key': `prov:${external}` },
    );
    if (last.status !== 503) {
      return last;
    }
    await sleep(150 * (attempt + 1));
  }
  return last;
}

export async function scalar(owner: Client, sql: string, params: unknown[]): Promise<string> {
  const result = await owner.query<{ value: string | null }>(sql, params);
  return result.rows[0]?.value ?? '';
}

export async function assertWalletInvariants(owner: Client, walletId: string): Promise<void> {
  const negative = await scalar(
    owner,
    `select count(*)::text as value from wallets where balance_amount < 0`,
    [],
  );
  if (negative !== '0') {
    throw new Error('A wallet balance is negative');
  }
  const rows = await owner.query<{
    direction: string;
    amount: string;
    balance_before: string;
    balance_after: string;
    transaction_id: string;
  }>(
    `select direction,
            amount::text as amount,
            balance_before::text as balance_before,
            balance_after::text as balance_after,
            transaction_id
       from wallet_ledger_entries
      where wallet_id = $1
      order by id`,
    [walletId],
  );
  const seen = new Set<string>();
  let previous = '0.00';
  for (const row of rows.rows) {
    if (seen.has(row.transaction_id)) {
      throw new Error(`Duplicate ledger transaction ${row.transaction_id}`);
    }
    seen.add(row.transaction_id);
    if (row.balance_before !== previous) {
      throw new Error(`Ledger chain broke at ${row.transaction_id}`);
    }
    const before = Money.from({ amount: row.balance_before, currency: 'BRL' });
    const amount = Money.from({ amount: row.amount, currency: 'BRL' });
    const after = row.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    if (row.balance_after !== after.toJSON().amount) {
      throw new Error(`Ledger arithmetic broke at ${row.transaction_id}`);
    }
    previous = row.balance_after;
  }
  const balance = await scalar(
    owner,
    `select balance_amount::text as value from wallets where id = $1`,
    [walletId],
  );
  if (balance !== previous) {
    throw new Error(`Materialized balance ${balance} does not match ledger ${previous}`);
  }
  const version = await scalar(owner, `select version::text as value from wallets where id = $1`, [walletId]);
  if (version !== String(rows.rows.length)) {
    throw new Error(`Version ${version} does not match ${rows.rows.length} balance-changing entries`);
  }
  const duplicateReversal = await scalar(
    owner,
    `select count(*)::text as value from (
       select reference_transaction_id
         from wager_transactions
        where wallet_id = $1
          and status = 'PROCESSED'
          and kind in ('REFUND', 'ROLLBACK')
        group by reference_transaction_id
       having count(*) > 1
     ) duplicated`,
    [walletId],
  );
  if (duplicateReversal !== '0') {
    throw new Error('More than one PROCESSED reversal exists for a reference');
  }
}

export async function waitForValue(
  read: () => Promise<string>,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await read();
    if (last === expected) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${expected}; last value was ${last}`);
}

export async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({
      connectionString: required('DATABASE_URL'),
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await sleep(500);
    }
  }
  throw new Error('PostgreSQL did not accept connections again');
}

export async function waitForLocalStack(): Promise<void> {
  const endpoint = required('AWS_ENDPOINT_URL');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/_localstack/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // LocalStack is still restarting.
    }
    await sleep(500);
  }
  throw new Error('LocalStack did not become healthy');
}

export function resultPath(name: string): string {
  return join(tmpdir(), `wager-phase5-${name}-${process.pid}.json`);
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

export async function receiveOne(
  sqs: SQSClient,
  queueUrl: string,
  waitSeconds: number,
): Promise<{ body: string; receipt: string } | undefined> {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitSeconds,
    }),
  );
  const message = response.Messages?.[0];
  if (message?.Body === undefined || message.ReceiptHandle === undefined) {
    return undefined;
  }
  return { body: message.Body, receipt: message.ReceiptHandle };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}
