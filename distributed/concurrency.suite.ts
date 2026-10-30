import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { ensureQueues } from '../src/messaging/ensure-queues';
import { createSqsClient } from '../src/messaging/sqs-client';
import { WAGER_DOMAIN_EVENTS_QUEUE, WAGER_TRANSACTIONS_DLQ, WAGER_TRANSACTIONS_QUEUE } from '../src/messaging/queue-names';
import { buildMigrationMikroOrmConfig } from '../src/persistence/mikro-orm.config';
import { holdSchemaLock } from '../test/support/database-lock';
import {
  assertWalletInvariants,
  connectOwner,
  dropEffectTable,
  ensureEffectTable,
  openWallet,
  postWager,
  prepareQueues,
  resultPath,
  runtimeEnv,
  scalar,
  sendQueueMessage,
  truncateFinancial,
  wagerEnvelope,
  waitForLive,
  waitForLocalStack,
  waitForPostgres,
  waitForValue,
} from './harness';
import {
  ProcessRegistry,
  sleep,
  waitForExit,
  type TrackedProcess,
} from './process-registry';

const root = process.cwd();
const registry = new ProcessRegistry(root);
const HTTP_PORTS = [3471, 3472, 3473];
const evidence: Array<{ scenario: string; pids: number[] }> = [];

const state: {
  release?: () => Promise<void>;
  owner?: Client;
  sqs?: SQSClient;
  urls: Map<string, string>;
  http: TrackedProcess[];
  workers: TrackedProcess[];
  consumers: TrackedProcess[];
  publishers: TrackedProcess[];
} = {
  urls: new Map(),
  http: [],
  workers: [],
  consumers: [],
  publishers: [],
};

process.on('exit', () => {
  registry.killSync();
});

describe('Fase 5', () => {
  beforeAll(async () => {
    state.release = await holdSchemaLock();
    const orm = await MikroORM.init(buildMigrationMikroOrmConfig());
    await orm.migrator.up();
    await orm.close(true);
    state.sqs = createSqsClient();
    await ensureQueues(state.sqs);
    state.urls = await prepareQueues(state.sqs);
    state.owner = await connectOwner();
    await truncateFinancial(state.owner);
    await ensureEffectTable(state.owner);
    await startHttp();
  }, 180_000);

  afterAll(async () => {
    await stopList(state.publishers);
    await stopList(state.workers);
    await stopList(state.consumers);
    await stopList(state.http);
    await registry.stopAll();
    console.log(JSON.stringify({ phase: 5, testPid: process.pid, evidence }));
    if (state.owner !== undefined) {
      await dropEffectTable(state.owner).catch(() => undefined);
      await state.owner.end().catch(() => undefined);
    }
    state.sqs?.destroy();
    await state.release?.().catch(() => undefined);
  }, 60_000);

  test('três processos HTTP disputam a mesma aposta uma única vez', async () => {
    remember('tc1-http', state.http);
    assertAlive(state.http);
    const playerId = nid('fifty');
    const walletId = await openWallet(HTTP_PORTS[0] ?? 3471, playerId, '100.00');
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_unused, index) => postWager(portAt(index), walletId, playerId, 'bet-fifty', 'BET', '10.00')),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.body.idempotentReplay === false).length).toBeLessThanOrEqual(1);
    const transactionIds = new Set(responses.map((response) => response.body.transactionId));
    expect(transactionIds.size).toBe(1);
    const replay = await postWager(portAt(0), walletId, playerId, 'bet-fifty', 'BET', '10.00');
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(responses[0]?.body.transactionId);
    expect(await debitCount(walletId, '10.00')).toBe('1');
    expect(await balanceOf(walletId)).toBe('90.00');
    await assertWalletInvariants(owner(), walletId);
    expect(await triggerCount()).toBe('1');
  }, 60_000);

  test('duas apostas de 80.00 em processos diferentes deixam saldo 20.00', async () => {
    remember('tc2-http', state.http);
    const playerId = nid('hot');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const [left, right] = await Promise.all([
      postWager(portAt(0), walletId, playerId, 'bet-left', 'BET', '80.00'),
      postWager(portAt(1), walletId, playerId, 'bet-right', 'BET', '80.00'),
    ]);
    const results = [left, right];
    expect(results.map((response) => response.status).sort()).toEqual([200, 422]);
    const rejected = results.find((response) => response.status === 422);
    expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(walletId)).toBe('20.00');
    expect(await debitCount(walletId, '80.00')).toBe('1');
    const winner = results.find((response) => response.status === 200);
    const winnerExternal = winner === left ? 'bet-left' : 'bet-right';
    const replay = await postWager(portAt(2), walletId, playerId, winnerExternal, 'BET', '80.00');
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(winner?.body.transactionId);
    expect(amountOf(replay.body.balance)).toBe('20.00');
    expect(await debitCount(walletId, '80.00')).toBe('1');
    await assertWalletInvariants(owner(), walletId);
  }, 60_000);

  test('a wallet B conclui enquanto a wallet A está travada', async () => {
    const playerA = nid('lock-a');
    const playerB = nid('lock-b');
    const walletA = await openWallet(portAt(0), playerA, '100.00');
    const walletB = await openWallet(portAt(1), playerB, '100.00');
    const holder = registry.spawn(
      'distributed/hold-wallet-lock.ts',
      runtimeEnv({ HOLD_WALLET_ID: walletA, HOLD_MS: '5000' }),
      'hold-a',
    );
    await waitForLog(holder, '"holding":true', 10_000);
    const started = Date.now();
    const betB = await postWager(portAt(2), walletB, playerB, 'bet-b', 'BET', '40.00');
    const elapsed = Date.now() - started;
    expect(betB.status).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
    expect(await balanceOf(walletB)).toBe('60.00');
    await registry.stop(holder);
    const betA = await postWager(portAt(0), walletA, playerA, 'bet-a', 'BET', '40.00');
    expect(betA.status).toBe(200);
    expect(await balanceOf(walletA)).toBe('60.00');
    remember('tc3-parallel-wallets', [...state.http, holder]);
    await assertWalletInvariants(owner(), walletA);
    await assertWalletInvariants(owner(), walletB);
  }, 30_000);

  test('REFUND e ROLLBACK concorrentes ocupam uma única vaga', async () => {
    const playerId = nid('slot');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const bet = await postWager(portAt(0), walletId, playerId, 'bet-slot', 'BET', '25.00');
    expect(bet.status).toBe(200);
    const [refund, rollback] = await Promise.all([
      postWager(portAt(1), walletId, playerId, 'refund-slot', 'REFUND', '25.00', 'bet-slot'),
      postWager(portAt(2), walletId, playerId, 'rollback-slot', 'ROLLBACK', '25.00', 'bet-slot'),
    ]);
    const results = [refund, rollback];
    expect(results.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(results.find((response) => response.status === 422)?.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await creditCount(walletId, '25.00')).toBe('1');
    await assertWalletInvariants(owner(), walletId);
    remember('tc7-race', state.http);
  }, 30_000);

  test('ROLLBACK da WIN e REFUND da BET podem os dois ser processados', async () => {
    const playerId = nid('chain');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    expect((await postWager(portAt(0), walletId, playerId, 'bet-chain', 'BET', '25.00')).status).toBe(200);
    expect((await postWager(portAt(1), walletId, playerId, 'win-chain', 'WIN', '10.00', 'bet-chain')).status).toBe(200);
    const [refund, rollback] = await Promise.all([
      postWager(portAt(1), walletId, playerId, 'refund-chain', 'REFUND', '25.00', 'bet-chain'),
      postWager(portAt(2), walletId, playerId, 'rollback-win', 'ROLLBACK', '10.00', 'win-chain'),
    ]);
    expect(refund.status).toBe(200);
    expect(rollback.status).toBe(200);
    expect(await balanceOf(walletId)).toBe('100.00');
    await assertWalletInvariants(owner(), walletId);
  }, 30_000);

  test('replay preserva o saldo observado e LOSS não muda version', async () => {
    const playerId = nid('replay');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const first = await postWager(portAt(0), walletId, playerId, 'bet-replay', 'BET', '30.00');
    expect(amountOf(first.body.balance)).toBe('70.00');
    const before = await terminalSnapshot('bet-replay');
    const versionAfterBet = await versionOf(walletId);
    const loss = await postWager(portAt(1), walletId, playerId, 'loss-replay', 'LOSS', '10.00');
    expect(loss.status).toBe(200);
    expect(await balanceOf(walletId)).toBe('70.00');
    expect(await versionOf(walletId)).toBe(versionAfterBet);
    const later = await postWager(portAt(2), walletId, playerId, 'bet-later', 'BET', '5.00');
    expect(amountOf(later.body.balance)).toBe('65.00');
    const replay = await postWager(portAt(1), walletId, playerId, 'bet-replay', 'BET', '30.00');
    expect(replay.body.idempotentReplay).toBe(true);
    expect(amountOf(replay.body.balance)).toBe('70.00');
    expect(await balanceOf(walletId)).toBe('65.00');
    expect(await terminalSnapshot('bet-replay')).toEqual(before);
    await assertWalletInvariants(owner(), walletId);
  }, 30_000);

  test('crash depois do commit e antes do ack não debita de novo', async () => {
    await stopList(state.workers);
    const playerId = nid('ack');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const external = 'bet-ack';
    await sendInput(wagerEnvelope(walletId, playerId, external, 'BET', '15.00'), `ack-${external}`, walletId);
    const crashed = await crashProcess('before-ack');
    remember('tc5-crash-before-ack', [crashed, ...state.http]);
    expect(await balanceOf(walletId)).toBe('85.00');
    expect(await debitCount(walletId, '15.00')).toBe('1');
    const worker = await startWorker('redelivery');
    await waitForLog(worker, 'msg-bet-ack', 15_000);
    expect(await debitCount(walletId, '15.00')).toBe('1');
    expect(await countWager(external)).toBe('1');
    expect(await scalar(owner(), `select count(*)::text as value from inbox_messages where message_id = $1`, [`msg-${external}`])).toBe('1');
    await assertWalletInvariants(owner(), walletId);
    await registry.stop(worker);
  }, 60_000);

  test('crash depois do commit e antes do SendMessage publica o mesmo eventId', async () => {
    await stopList(state.workers);
    await stopList(state.publishers);
    await drainOutbox();
    const playerId = nid('publish');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    expect((await postWager(portAt(1), walletId, playerId, 'bet-publish', 'BET', '5.00')).status).toBe(200);
    const crashed = await crashProcess('before-publish');
    const eventId = readCrash(crashed).eventId;
    expect(typeof eventId).toBe('string');
    expect(await scalar(owner(), `select published_at::text as value from outbox_messages where id = $1`, [eventId])).toBe('');
    const publisher = await startWorker('publisher-recovery');
    await waitForValue(
      () => scalar(owner(), `select count(*)::text as value from outbox_messages where aggregate_id = $1 and published_at is null`, [walletId]),
      '0',
      15_000,
    );
    const kept = await scalar(owner(), `select count(*)::text as value from outbox_messages where id = $1`, [eventId]);
    expect(kept).toBe('1');
    remember('tc5-publish', [crashed, publisher, ...state.http]);
    await assertWalletInvariants(owner(), walletId);
    await registry.stop(publisher);
  }, 60_000);

  test('crash depois do SendMessage deduplica o efeito pelo eventId persistido', async () => {
    await stopList(state.workers);
    await stopList(state.publishers);
    await drainOutbox();
    await startConsumers(2);
    const playerId = nid('effect');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    expect((await postWager(portAt(2), walletId, playerId, 'bet-effect', 'BET', '8.00')).status).toBe(200);
    const before = await balanceOf(walletId);
    const crashed = await crashProcess('after-send');
    const eventId = readCrash(crashed).eventId;
    expect(await scalar(owner(), `select published_at::text as value from outbox_messages where id = $1`, [eventId])).toBe('');
    const payload = await owner().query<{ payload: unknown }>(`select payload from outbox_messages where id = $1`, [eventId]);
    const body = typeof payload.rows[0]?.payload === 'string'
      ? payload.rows[0].payload
      : JSON.stringify(payload.rows[0]?.payload);
    await sendDomain(body, `forced-${eventId}`, walletId);
    await waitForValue(
      () => scalar(owner(), `select deliveries::text as value from test_domain_event_effects where event_id = $1`, [eventId]),
      '2',
      15_000,
    );
    expect(await scalar(owner(), `select count(*)::text as value from test_domain_event_effects where event_id = $1`, [eventId])).toBe('1');
    const publisher = await startWorker('publish-after-crash');
    await waitForValue(
      () => scalar(owner(), `select count(*)::text as value from outbox_messages where id = $1 and published_at is not null`, [eventId]),
      '1',
      15_000,
    );
    expect(await scalar(owner(), `select count(*)::text as value from outbox_messages where id = $1`, [eventId])).toBe('1');
    expect(await balanceOf(walletId)).toBe(before);
    remember('event-dedup', [crashed, publisher, ...state.consumers]);
    await assertWalletInvariants(owner(), walletId);
    await registry.stop(publisher);
  }, 60_000);

  test('três publishers sobrepostos enviam cada eventId uma vez', async () => {
    await stopList(state.workers);
    await stopList(state.publishers);
    await drainOutbox();
    await startConsumers(2);
    const wallets: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const playerId = nid(`pub-${index}`);
      const walletId = await openWallet(portAt(index), playerId, '50.00');
      expect((await postWager(portAt(index), walletId, playerId, `bet-pub-${index}`, 'BET', '5.00')).status).toBe(200);
      wallets.push(walletId);
    }
    const flag = join(tmpdir(), `wager-phase5-flag-${process.pid}.txt`);
    unlinkIfPresent(flag);
    const publishers = [0, 1, 2].map((index) =>
      registry.spawn('distributed/publisher-main.ts', runtimeEnv({ START_FLAG: flag }), `publisher-${index}`),
    );
    state.publishers.push(...publishers);
    await Promise.all(publishers.map((publisher) => waitForLog(publisher, '"ready":true', 20_000)));
    writeFileSync(flag, 'go');
    for (const walletId of wallets) {
      await waitForValue(
        () => scalar(owner(), `select count(*)::text as value from outbox_messages where aggregate_id = $1 and published_at is null`, [walletId]),
        '0',
        15_000,
      );
    }
    const byProcess = publishers.map((publisher) => eventIdsFrom(publisher.logs));
    const published = byProcess.flat();
    expect(new Set(published).size).toBe(published.length);
    expect(byProcess.filter((ids) => ids.length > 0).length).toBeGreaterThanOrEqual(2);
    const stored = await owner().query<{ id: string }>(
      `select id::text as id from outbox_messages where aggregate_id::text = any($1::text[])`,
      [wallets],
    );
    for (const row of stored.rows) {
      await waitForValue(
        () => scalar(owner(), `select count(*)::text as value from test_domain_event_effects where event_id = $1`, [row.id]),
        '1',
        10_000,
      );
    }
    remember('tc6-publishers', publishers);
    for (const walletId of wallets) {
      await assertWalletInvariants(owner(), walletId);
    }
    await stopList(state.publishers);
  }, 90_000);

  test('SIGTERM durante o lock devolve a mensagem e outro processo conclui', async () => {
    await stopList(state.workers);
    const playerId = nid('term');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const holder = registry.spawn(
      'distributed/hold-wallet-lock.ts',
      runtimeEnv({ HOLD_WALLET_ID: walletId, HOLD_MS: '8000' }),
      'hold-term',
    );
    await waitForLog(holder, '"holding":true', 10_000);
    const worker = await startWorker('sigterm');
    const dedup = `sigterm-${nid('dedup')}`;
    await sendInput(wagerEnvelope(walletId, playerId, 'bet-term', 'BET', '12.00'), dedup, walletId);
    await waitUntilLockWait();
    const code = await registry.stop(worker, 'SIGTERM');
    expect(code).toBe(0);
    expect(await countWager('bet-term')).toBe('0');
    await registry.stop(holder, 'SIGKILL');
    await owner().query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and query ilike '%pg_sleep%'`,
    );
    const replacement = await startWorker('sigterm-replacement');
    try {
      await waitForValue(() => countWager('bet-term'), '1', 15_000);
    } catch (error) {
      const attributes = await queueAttributes(queueUrl(WAGER_TRANSACTIONS_QUEUE));
      throw new Error(
        `${error instanceof Error ? error.message : 'sigterm follow-up failed'}\nfirst\n${worker.logs.slice(-2_000)}\nreplacement\n${replacement.logs.slice(-2_000)}\nqueue ${attributes}`,
        { cause: error },
      );
    }
    expect(await debitCount(walletId, '12.00')).toBe('1');
    remember('sigterm', [worker, replacement, holder]);
    await assertWalletInvariants(owner(), walletId);
    await registry.stop(replacement);
  }, 40_000);

  test('mensagem inválida vai à DLQ sem efeito financeiro', async () => {
    await stopList(state.workers);
    const worker = await startWorker('dlq');
    const canary = 'SECRET-AMOUNT-77.77';
    const body = JSON.stringify({
      messageId: 'poison-canary',
      type: 'NotAWager',
      note: canary,
    });
    await sendInput(body, 'poison-canary-dedup', 'poison-canary');
    await waitForValue(
      () => scalar(owner(), `select count(*)::text as value from ingress_rejects where message_id = $1`, ['poison-canary']),
      '1',
      10_000,
    );
    const dlq = await receiveBody(queueUrl(WAGER_TRANSACTIONS_DLQ), 10);
    expect(dlq).toContain(canary);
    expect(worker.logs).not.toContain(canary);
    expect(await scalar(owner(), `select count(*)::text as value from wager_transactions where external_transaction_id = $1`, ['poison-canary'])).toBe('0');
    remember('dlq', [worker, ...state.http]);
    await registry.stop(worker);
  }, 30_000);

  test('lease vencido não cria segundo crédito', async () => {
    await stopList(state.workers);
    const playerId = nid('lease');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const pending = await postWager(portAt(1), walletId, playerId, 'refund-lease', 'REFUND', '20.00', 'bet-lease');
    expect(pending.status).toBe(202);
    const holder = registry.spawn(
      'distributed/hold-wallet-lock.ts',
      runtimeEnv({ HOLD_WALLET_ID: walletId, HOLD_MS: '1500' }),
      'hold-lease',
    );
    await waitForLog(holder, '"holding":true', 10_000);
    const workers = await startWorkers(2, { CLAIM_LEASE_MS: '100', PENDING_MAX_ATTEMPTS: '30' }, 'lease');
    await sleep(1_200);
    await registry.stop(holder);
    await sleep(400);
    const attempts = Number(await scalar(
      owner(),
      `select attempt_count::text as value from wager_transactions where external_transaction_id = $1`,
      ['refund-lease'],
    ));
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await creditCount(walletId, '20.00')).toBe('0');
    expect((await postWager(portAt(2), walletId, playerId, 'bet-lease', 'BET', '20.00')).status).toBe(200);
    await waitForValue(() => statusOf('refund-lease'), 'PROCESSED', 10_000);
    expect(await creditCount(walletId, '20.00')).toBe('1');
    expect(await balanceOf(walletId)).toBe('100.00');
    remember('lease', [...workers, holder]);
    await assertWalletInvariants(owner(), walletId);
    await stopList(state.workers);
  }, 40_000);

  test('três workers resolvem uma referência pendente com um crédito', async () => {
    await stopList(state.workers);
    const playerId = nid('pending');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    const pending = await postWager(portAt(1), walletId, playerId, 'refund-pending', 'REFUND', '30.00', 'bet-pending');
    expect(pending.status).toBe(202);
    const workers = await startWorkers(3, { PENDING_MAX_ATTEMPTS: '30' }, 'pending');
    expect((await postWager(portAt(2), walletId, playerId, 'bet-pending', 'BET', '30.00')).status).toBe(200);
    await waitForValue(() => statusOf('refund-pending'), 'PROCESSED', 10_000);
    expect(await creditCount(walletId, '30.00')).toBe('1');
    expect(await balanceOf(walletId)).toBe('100.00');
    remember('pending-workers', workers);
    await assertWalletInvariants(owner(), walletId);
    await stopList(state.workers);
  }, 40_000);

  test('LocalStack reinicia e o evento commitado continua publicável', async () => {
    await stopList(state.workers);
    await stopList(state.publishers);
    await drainOutbox();
    const playerId = nid('sqs-down');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    expect((await postWager(portAt(1), walletId, playerId, 'bet-sqs-down', 'BET', '9.00')).status).toBe(200);
    const balance = await balanceOf(walletId);
    const pending = await scalar(
      owner(),
      `select count(*)::text as value from outbox_messages where aggregate_id = $1 and published_at is null`,
      [walletId],
    );
    expect(Number(pending)).toBeGreaterThan(0);
    const watcher = await startWorker('during-localstack-restart');
    await compose(['restart', 'localstack']);
    const survived = watcher.child.exitCode === null && watcher.child.signalCode === null;
    await waitForLocalStack();
    if (survived) {
      await registry.stop(watcher);
    }
    const sqs = createSqsClient();
    await ensureQueues(sqs);
    state.sqs?.destroy();
    state.sqs = sqs;
    state.urls = await prepareQueues(sqs);
    const worker = await startWorker('after-localstack');
    await waitForValue(
      () => scalar(owner(), `select count(*)::text as value from outbox_messages where aggregate_id = $1 and published_at is null`, [walletId]),
      '0',
      20_000,
    );
    const kept = await scalar(
      owner(),
      `select count(*)::text as value from outbox_messages where aggregate_id = $1`,
      [walletId],
    );
    expect(Number(kept)).toBeGreaterThan(0);
    expect(await balanceOf(walletId)).toBe(balance);
    const playerAfter = nid('sqs-after');
    const walletAfter = await openWallet(portAt(2), playerAfter, '40.00');
    await sendInput(wagerEnvelope(walletAfter, playerAfter, 'bet-after-localstack', 'BET', '4.00'), 'after-localstack', walletAfter);
    await waitForValue(() => countWager('bet-after-localstack'), '1', 15_000);
    expect(await debitCount(walletAfter, '4.00')).toBe('1');
    console.log(JSON.stringify({ scenario: 'localstack-restart', survived, watcherPid: watcher.pid, workerPid: worker.pid }));
    remember('localstack', [watcher, worker, ...state.http]);
    await assertWalletInvariants(owner(), walletId);
    await assertWalletInvariants(owner(), walletAfter);
    await registry.stop(worker);
  }, 180_000);

  test('PostgreSQL reinicia e a aposta seguinte continua única', async () => {
    await stopList(state.workers);
    await stopList(state.publishers);
    await stopList(state.consumers);
    const playerId = nid('pg-down');
    const walletId = await openWallet(portAt(0), playerId, '100.00');
    expect((await postWager(portAt(1), walletId, playerId, 'bet-before-restart', 'BET', '11.00')).status).toBe(200);
    const watcher = await startWorker('during-postgres-restart');
    await stopList(state.http);
    await state.owner?.end().catch(() => undefined);
    state.owner = undefined;
    await state.release?.().catch(() => undefined);
    state.release = undefined;
    await compose(['restart', 'postgres']);
    await waitForPostgres();
    state.release = await holdSchemaLock();
    state.owner = await connectOwner();
    const survived = watcher.child.exitCode === null && watcher.child.signalCode === null;
    if (survived) {
      await registry.stop(watcher);
    }
    await startHttp();
    const worker = await startWorker('after-postgres');
    const secondPlayer = nid('pg-after');
    const secondWallet = await openWallet(portAt(0), secondPlayer, '80.00');
    await sendInput(wagerEnvelope(secondWallet, secondPlayer, 'bet-after-restart', 'BET', '6.00'), 'after-restart', secondWallet);
    await waitForValue(() => countWager('bet-after-restart'), '1', 20_000);
    expect(await debitCount(walletId, '11.00')).toBe('1');
    expect(await balanceOf(walletId)).toBe('89.00');
    expect(await debitCount(secondWallet, '6.00')).toBe('1');
    console.log(JSON.stringify({
      scenario: 'postgres-restart',
      survived,
      watcherPid: watcher.pid,
      workerPid: worker.pid,
      watcherTail: watcher.logs.slice(-1_500),
    }));
    remember('postgres', [watcher, worker, ...state.http]);
    await assertWalletInvariants(owner(), walletId);
    await assertWalletInvariants(owner(), secondWallet);
    await registry.stop(worker);
  }, 180_000);
});

function owner(): Client {
  if (state.owner === undefined) {
    throw new Error('Owner connection is not open');
  }
  return state.owner;
}

function queueUrl(name: string): string {
  const url = state.urls.get(name);
  if (url === undefined) {
    throw new Error(`Queue URL missing for ${name}`);
  }
  return url;
}

function portAt(index: number): number {
  return HTTP_PORTS[index % HTTP_PORTS.length] ?? 3471;
}

function nid(prefix: string): string {
  return `p5-${prefix}-${randomBytes(4).toString('hex')}`;
}

async function startHttp(): Promise<TrackedProcess[]> {
  await stopList(state.http);
  const started = HTTP_PORTS.map((port) =>
    registry.spawn('src/main.ts', runtimeEnv({ PORT: String(port) }), `http-${port}`),
  );
  state.http = started;
  await Promise.all(HTTP_PORTS.map((port) => waitForLive(port)));
  return started;
}

async function startWorker(label: string, extra: Record<string, string> = {}): Promise<TrackedProcess> {
  const worker = registry.spawn('src/worker-main.ts', runtimeEnv(extra), label);
  state.workers.push(worker);
  await waitForLog(worker, 'async workers started', 20_000);
  return worker;
}

async function startWorkers(count: number, extra: Record<string, string>, label: string): Promise<TrackedProcess[]> {
  const started: TrackedProcess[] = [];
  for (let index = 0; index < count; index += 1) {
    started.push(await startWorker(`${label}-${index}`, extra));
  }
  return started;
}

async function startConsumers(count: number): Promise<void> {
  const alive = state.consumers.filter((consumer) => consumer.child.exitCode === null);
  if (alive.length >= count) {
    state.consumers = alive;
    return;
  }
  await stopList(state.consumers);
  const started: TrackedProcess[] = [];
  for (let index = 0; index < count; index += 1) {
    const ready = resultPath(`consumer-${index}`);
    unlinkIfPresent(ready);
    const consumer = registry.spawn(
      'distributed/event-consumer-main.ts',
      runtimeEnv({ CONSUMER_READY_PATH: ready }),
      `event-consumer-${index}`,
    );
    started.push(consumer);
    await waitForFile(ready, 15_000);
  }
  state.consumers = started;
}

async function drainOutbox(): Promise<void> {
  const pending = await scalar(owner(), `select count(*)::text as value from outbox_messages where published_at is null`, []);
  if (pending === '0') {
    return;
  }
  await startConsumers(1);
  const worker = await startWorker('drain');
  await waitForValue(
    () => scalar(owner(), `select count(*)::text as value from outbox_messages where published_at is null`, []),
    '0',
    20_000,
  );
  await registry.stop(worker);
  state.workers = state.workers.filter((item) => item !== worker);
}

async function crashProcess(mode: string): Promise<TrackedProcess> {
  const path = resultPath(mode);
  unlinkIfPresent(path);
  const crashed = registry.spawn(
    'distributed/crash-main.ts',
    runtimeEnv({ CRASH_MODE: mode, CRASH_RESULT_PATH: path }),
    `crash-${mode}`,
  );
  const raw = await waitForFile(path, 25_000);
  const parsed = JSON.parse(raw) as { error?: string };
  if (parsed.error !== undefined) {
    throw new Error(`${mode} failed: ${parsed.error}\n${crashed.logs}`);
  }
  await registry.stop(crashed, 'SIGKILL');
  return crashed;
}

function readCrash(tracked: TrackedProcess): { eventId: string } {
  const match = /crash-(before-ack|before-publish|after-send)/.exec(tracked.label);
  const mode = match?.[1] ?? 'before-publish';
  return JSON.parse(readFileSync(resultPath(mode), 'utf8')) as { eventId: string };
}

async function sendInput(body: string, dedupId: string, groupId: string): Promise<void> {
  const sqs = state.sqs;
  if (sqs === undefined) {
    throw new Error('SQS client is not open');
  }
  await sendQueueMessage(sqs, queueUrl(WAGER_TRANSACTIONS_QUEUE), body, groupId, dedupId);
}

async function sendDomain(body: string, dedupId: string, groupId: string): Promise<void> {
  const sqs = state.sqs;
  if (sqs === undefined) {
    throw new Error('SQS client is not open');
  }
  await sendQueueMessage(sqs, queueUrl(WAGER_DOMAIN_EVENTS_QUEUE), body, groupId, dedupId);
}

async function queueAttributes(url: string): Promise<string> {
  const sqs = state.sqs;
  if (sqs === undefined) {
    return 'no-sqs';
  }
  const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
  const response = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return JSON.stringify(response.Attributes ?? {});
}

async function receiveBody(url: string, waitSeconds: number): Promise<string> {
  const sqs = state.sqs;
  if (sqs === undefined) {
    throw new Error('SQS client is not open');
  }
  const deadline = Date.now() + waitSeconds * 1_000;
  while (Date.now() < deadline) {
    const { ReceiveMessageCommand } = await import('@aws-sdk/client-sqs');
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    const message = response.Messages?.[0];
    if (message?.Body !== undefined && message.ReceiptHandle !== undefined) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
      return message.Body;
    }
  }
  throw new Error('DLQ did not deliver the invalid message');
}

async function compose(args: string[]): Promise<void> {
  const child = spawn('docker', ['compose', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const code = await waitForExit(child, 120_000);
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited ${code ?? 'signal'}\n${output}`);
  }
}

async function stopList(list: TrackedProcess[]): Promise<void> {
  const current = list.splice(0);
  await Promise.all(current.map((tracked) => registry.stop(tracked)));
}

function remember(scenario: string, processes: TrackedProcess[]): void {
  const pids = [...new Set(processes.map((tracked) => tracked.pid))];
  expect(pids).not.toContain(process.pid);
  expect(pids.length).toBeGreaterThan(0);
  evidence.push({ scenario, pids });
  console.log(JSON.stringify({ scenario, pids, testPid: process.pid }));
}

function assertAlive(processes: TrackedProcess[]): void {
  for (const tracked of processes) {
    expect(tracked.child.exitCode).toBeNull();
    process.kill(tracked.pid, 0);
  }
}

async function waitForLog(tracked: TrackedProcess, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tracked.logs.includes(text)) {
      return;
    }
    if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
      throw new Error(`${tracked.label} exited before logging ${text}\n${tracked.logs}`);
    }
    await sleep(50);
  }
  throw new Error(`${tracked.label} did not log ${text}\n${tracked.logs.slice(-2_000)}`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
    await sleep(50);
  }
  throw new Error(`Result file was not written: ${path}`);
}

function unlinkIfPresent(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function eventIdsFrom(logs: string): string[] {
  const ids: string[] = [];
  for (const line of logs.split('\n')) {
    if (!line.includes('outbox event published')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { eventId?: unknown };
      if (typeof parsed.eventId === 'string') {
        ids.push(parsed.eventId);
      }
    } catch {
      // Nest or other stdout is ignored.
    }
  }
  return ids;
}

async function balanceOf(walletId: string): Promise<string> {
  return scalar(owner(), `select balance_amount::text as value from wallets where id = $1`, [walletId]);
}

async function versionOf(walletId: string): Promise<string> {
  return scalar(owner(), `select version::text as value from wallets where id = $1`, [walletId]);
}

async function debitCount(walletId: string, amount: string): Promise<string> {
  return scalar(
    owner(),
    `select count(*)::text as value
       from wallet_ledger_entries
      where wallet_id = $1 and direction = 'DEBIT' and amount = $2::numeric`,
    [walletId, amount],
  );
}

async function creditCount(walletId: string, amount: string): Promise<string> {
  return scalar(
    owner(),
    `select count(*)::text as value
       from wallet_ledger_entries
      where wallet_id = $1 and direction = 'CREDIT' and amount = $2::numeric`,
    [walletId, amount],
  );
}

async function countWager(external: string): Promise<string> {
  return scalar(
    owner(),
    `select count(*)::text as value from wager_transactions where external_transaction_id = $1`,
    [external],
  );
}

async function statusOf(external: string): Promise<string> {
  return scalar(owner(), `select status as value from wager_transactions where external_transaction_id = $1`, [external]);
}

async function waitUntilLockWait(): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const waiting = await scalar(
      owner(),
      `select count(*)::text as value
         from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%for update%'`,
      [],
    );
    if (waiting !== '0') {
      return;
    }
    await sleep(50);
  }
  throw new Error('No wallet lock wait was observed');
}

async function triggerCount(): Promise<string> {
  return scalar(
    owner(),
    `select count(*)::text as value from pg_trigger where tgname = 'wallet_ledger_entries_append_only' and not tgisinternal`,
    [],
  );
}

async function terminalSnapshot(external: string): Promise<{ status: string; processedAt: string; observed: string }> {
  const result = await owner().query<{
    status: string;
    processed_at: string;
    observed: string;
  }>(
    `select status,
            processed_at::text as processed_at,
            observed_balance_amount::text as observed
       from wager_transactions
      where external_transaction_id = $1`,
    [external],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Transaction ${external} was not found`);
  }
  return {
    status: row.status,
    processedAt: row.processed_at,
    observed: row.observed,
  };
}

function amountOf(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a money object');
  }
  const amount = (value as { amount?: unknown }).amount;
  if (typeof amount !== 'string') {
    throw new Error('Money amount is not a string');
  }
  return amount;
}

void function unusedHttpType(response: HttpResult): HttpResult {
  return response;
};
