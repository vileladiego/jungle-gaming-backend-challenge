import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { ReconcileWalletService } from '../src/application/reconcile-wallet.service';
import { buildMigrationMikroOrmConfig } from '../src/persistence/mikro-orm.config';
import { holdSchemaLock } from './support/database-lock';

let baseUrl = '';

describe('Fase 4A', () => {
  let release: (() => Promise<void>) | undefined;
  let owner: MikroORM | undefined;
  let app: INestApplication | undefined;
  let ownerClient: Client | undefined;
  let reconcile: ReconcileWalletService | undefined;

  beforeAll(async () => {
    release = await holdSchemaLock();
    owner = await MikroORM.init(buildMigrationMikroOrmConfig());
    await owner.migrator.up();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('HTTP server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    ownerClient = new Client({ connectionString: process.env.DATABASE_URL });
    await ownerClient.connect();
    await ownerClient.query(
      `truncate table wallet_ledger_entries, wager_transactions, inbox_messages, outbox_messages, ingress_rejects, wallets`,
    );
    reconcile = app.get(ReconcileWalletService);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await ownerClient?.end();
    await owner?.close(true);
    await release?.();
  });

  test('health segue aberto e a abertura não exige credencial', async () => {
    const live = await request('GET', '/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await request('GET', '/health/ready');
    expect(ready.status).toBe(200);
    const created = await request('POST', '/wallets', {
      playerId: 'player-open-auth',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(created.status).toBe(201);
  });

  test('saldo zero e saldo positivo', async () => {
    const zero = await request('POST', '/wallets', {
      playerId: 'player-zero-http',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(zero.status).toBe(201);
    expect(zero.body.version).toBe(1);
    expect(amountOf(zero.body.balance)).toBe('0.00');
    expect(currencyOf(zero.body.balance)).toBe('BRL');
    const zeroId = text(zero.body.id);
    const zeroLedger = await request('GET', `/wallets/${zeroId}/ledger`);
    expect(zeroLedger.body.entries).toEqual([]);
    const zeroCheck = await request('POST', `/wallets/${zeroId}/reconciliation`, {});
    expect(zeroCheck.body.consistent).toBe(true);
    expect(zeroCheck.body.checkedEntries).toBe(0);

    const positive = await request('POST', '/wallets', {
      playerId: 'player-positive-http',
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(positive.status).toBe(201);
    expect(positive.body.version).toBe(1);
    expect(amountOf(positive.body.balance)).toBe('100.00');
    expect(currencyOf(positive.body.balance)).toBe('BRL');
    const walletId = text(positive.body.id);
    const loaded = await request('GET', `/wallets/${walletId}`);
    expect(loaded.status).toBe(200);
    expect(amountOf(loaded.body.balance)).toBe('100.00');
    const ledger = await request('GET', `/wallets/${walletId}/ledger`);
    const entries = asRecords(ledger.body.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe('CREDIT');
    expect(amountOf(entries[0]?.amount)).toBe('100.00');
    expect(currencyOf(entries[0]?.amount)).toBe('BRL');
    expect(amountOf(entries[0]?.balanceBefore)).toBe('0.00');
    expect(amountOf(entries[0]?.balanceAfter)).toBe('100.00');
    await expectConsistent(walletId, '100.00');
  });

  test('wallet duplicada, dinheiro numérico e precisão', async () => {
    const first = await request('POST', '/wallets', {
      playerId: 'player-dup-http',
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    expect(first.status).toBe(201);
    const duplicate = await request('POST', '/wallets', {
      playerId: 'player-dup-http',
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({ failureCode: 'WALLET_ALREADY_EXISTS' });
    expect(await count(`select count(*)::text as count from wallets where player_id = $1`, ['player-dup-http'])).toBe('1');
    const kept = await request('GET', `/wallets/${text(first.body.id)}`);
    expect(kept.status).toBe(200);
    expect(amountOf(kept.body.balance)).toBe('10.00');
    expect(currencyOf(kept.body.balance)).toBe('BRL');
    expect(currencyOf(first.body.balance)).toBe('BRL');

    const numeric = await request('POST', '/wallets', {
      playerId: 'player-numeric-http',
      initialBalance: { amount: 10, currency: 'BRL' },
    });
    expect(numeric.status).toBe(400);
    expect(numeric.body).toEqual({ failureCode: 'INVALID_PAYLOAD' });
    expect(await count(`select count(*)::text as count from wallets where player_id = $1`, ['player-numeric-http'])).toBe('0');

    const precise = await request('POST', '/wallets', {
      playerId: 'player-precise-http',
      initialBalance: { amount: '9007199254740993.99', currency: 'BRL' },
    });
    expect(precise.status).toBe(201);
    expect(amountOf(precise.body.balance)).toBe('9007199254740993.99');
    expect(currencyOf(precise.body.balance)).toBe('BRL');
    const again = await request('GET', `/wallets/${text(precise.body.id)}`);
    expect(amountOf(again.body.balance)).toBe('9007199254740993.99');
  });

  test('BET, WIN, LOSS, saldo insuficiente e moeda divergente', async () => {
    const walletId = await openWallet('player-kinds-http', '100.00');
    const bet = await wager(walletId, 'player-kinds-http', 'bet-1', 'BET', '30.00');
    expect(bet.status).toBe(200);
    expect(bet.body.status).toBe('PROCESSED');
    expect(bet.body.idempotentReplay).toBe(false);
    expect(amountOf(bet.body.balance)).toBe('70.00');
    expect(currencyOf(bet.body.balance)).toBe('BRL');
    const win = await wager(walletId, 'player-kinds-http', 'win-1', 'WIN', '15.00', 'bet-1');
    expect(win.status).toBe(200);
    expect(amountOf(win.body.balance)).toBe('85.00');
    const loss = await wager(walletId, 'player-kinds-http', 'loss-1', 'LOSS', '15.00');
    expect(loss.status).toBe(200);
    expect(loss.body.status).toBe('PROCESSED');
    expect(amountOf(loss.body.balance)).toBe('85.00');
    const short = await wager(walletId, 'player-kinds-http', 'bet-short', 'BET', '90.00');
    expect(short.status).toBe(422);
    expect(short.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(amountOf(short.body.balance)).toBe('85.00');
    const mismatch = await wager(walletId, 'player-kinds-http', 'bet-usd', 'BET', '1.00', undefined, 'USD');
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(currencyOf(mismatch.body.balance)).toBe('BRL');
    const loaded = await request('GET', `/wallets/${walletId}`);
    expect(amountOf(loaded.body.balance)).toBe('85.00');
    expect(currencyOf(loaded.body.balance)).toBe('BRL');
    await expectConsistent(walletId, '85.00');
    const found = await request('GET', `/wagering/transactions/${text(bet.body.transactionId)}`);
    expect(found.status).toBe(200);
    expect(found.body.kind).toBe('BET');
    expect(amountOf(found.body.money)).toBe('30.00');
    expect(currencyOf(found.body.money)).toBe('BRL');
    const byExternal = await request('GET', '/providers/prov/wagering/transactions/bet-1');
    expect(byExternal.body.transactionId).toBe(bet.body.transactionId);
    expect((await request('GET', `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });

  test('idempotência preserva o snapshot depois que o saldo muda', async () => {
    const walletId = await openWallet('player-idem-http', '100.00');
    const first = await wager(walletId, 'player-idem-http', 'idem-1', 'BET', '30.00');
    expect(first.status).toBe(200);
    const replay = await wager(walletId, 'player-idem-http', 'idem-1', 'BET', '30.00');
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(amountOf(replay.body.balance)).toBe('70.00');
    const later = await wager(walletId, 'player-idem-http', 'idem-2', 'BET', '10.00');
    expect(amountOf(later.body.balance)).toBe('60.00');
    const frozen = await wager(walletId, 'player-idem-http', 'idem-1', 'BET', '30.00');
    expect(frozen.body.idempotentReplay).toBe(true);
    expect(amountOf(frozen.body.balance)).toBe('70.00');
    expect(amountOf((await request('GET', `/wallets/${walletId}`)).body.balance)).toBe('60.00');
    const divergent = await wager(walletId, 'player-idem-http', 'idem-1', 'BET', '31.00');
    expect(divergent.status).toBe(409);
    expect(divergent.body).toEqual({ failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    const missingKey = await request('POST', '/wagering/transactions', {
      providerId: 'prov',
      externalTransactionId: 'idem-3',
      playerId: 'player-idem-http',
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body).toEqual({ failureCode: 'INVALID_PAYLOAD' });
    await expectConsistent(walletId, '60.00');
  });

  test('REFUND, ROLLBACK, reversão duplicada e referência inválida ou fora de ordem', async () => {
    const walletId = await openWallet('player-reversal-http', '100.00');
    const bet = await wager(walletId, 'player-reversal-http', 'rev-bet', 'BET', '25.00');
    expect(amountOf(bet.body.balance)).toBe('75.00');
    const refund = await wager(walletId, 'player-reversal-http', 'rev-refund', 'REFUND', '25.00', 'rev-bet');
    expect(refund.status).toBe(200);
    expect(amountOf(refund.body.balance)).toBe('100.00');
    const rollback = await wager(
      walletId,
      'player-reversal-http',
      'rev-rollback',
      'ROLLBACK',
      '25.00',
      'rev-refund',
    );
    expect(rollback.status).toBe(200);
    expect(amountOf(rollback.body.balance)).toBe('75.00');
    const second = await wager(walletId, 'player-reversal-http', 'rev-refund-2', 'REFUND', '25.00', 'rev-bet');
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(amountOf((await request('GET', `/wallets/${walletId}`)).body.balance)).toBe('75.00');

    const missing = await request(
      'POST',
      '/wagering/transactions',
      {
        providerId: 'prov',
        externalTransactionId: 'rev-no-ref',
        playerId: 'player-reversal-http',
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
      },
      { 'idempotency-key': 'prov:rev-no-ref' },
    );
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ failureCode: 'REFERENCE_REQUIRED' });
    expect(await count(`select count(*)::text as count from wager_transactions where external_transaction_id = $1`, ['rev-no-ref'])).toBe('0');

    const mismatch = await wager(walletId, 'player-reversal-http', 'rev-amount', 'REFUND', '10.00', 'rev-bet');
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.failureCode).toBe('AMOUNT_MISMATCH');

    const earlyRefund = await wager(
      walletId,
      'player-reversal-http',
      'rev-refund-missing',
      'REFUND',
      '25.00',
      'rev-bet-not-yet',
    );
    expect(earlyRefund.status).toBe(202);
    expect(earlyRefund.body.status).toBe('PENDING_REFERENCE');
    expect(amountOf(earlyRefund.body.balance)).toBe('75.00');
    const earlyRollback = await wager(
      walletId,
      'player-reversal-http',
      'rev-rollback-missing',
      'ROLLBACK',
      '25.00',
      'rev-refund-not-yet',
    );
    expect(earlyRollback.status).toBe(202);
    expect(earlyRollback.body.status).toBe('PENDING_REFERENCE');
    expect(amountOf(earlyRollback.body.balance)).toBe('75.00');

    const early = await wager(walletId, 'player-reversal-http', 'rev-early', 'WIN', '5.00', 'not-there-yet');
    expect(early.status).toBe(202);
    expect(early.body.status).toBe('PENDING_REFERENCE');
    expect(amountOf(early.body.balance)).toBe('75.00');
    const schedule = await ownerRows<{ next_attempt_at: Date; deadline_at: Date; attempt_count: number }>(
      `select next_attempt_at, deadline_at, attempt_count
         from wager_transactions
        where id = $1`,
      [text(early.body.transactionId)],
    );
    const next = schedule[0]?.next_attempt_at;
    const deadline = schedule[0]?.deadline_at;
    if (next === undefined || deadline === undefined) {
      throw new Error('Schedule was not stored');
    }
    expect(schedule[0]?.attempt_count).toBe(0);
    expect(deadline.getTime() - next.getTime()).toBe(Number(process.env.REFERENCE_TTL_MS ?? 15 * 60 * 1000));
    await expectConsistent(walletId, '75.00');
  });

  test('paginação do ledger é estável e a reconciliação não corrige divergência', async () => {
    const walletId = await openWallet('player-page-http', '100.00');
    await wager(walletId, 'player-page-http', 'page-1', 'BET', '1.00');
    await wager(walletId, 'player-page-http', 'page-2', 'BET', '1.00');
    await wager(walletId, 'player-page-http', 'page-3', 'BET', '1.00');
    const first = await request('GET', `/wallets/${walletId}/ledger?limit=2`);
    const firstEntries = asRecords(first.body.entries);
    expect(firstEntries).toHaveLength(2);
    const cursor = text(first.body.nextCursor);
    const firstAgain = await request('GET', `/wallets/${walletId}/ledger?limit=2`);
    expect(asRecords(firstAgain.body.entries).map((entry) => entry.id)).toEqual(firstEntries.map((entry) => entry.id));
    const second = await request('GET', `/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`);
    const secondEntries = asRecords(second.body.entries);
    expect(secondEntries).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...firstEntries, ...secondEntries].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(4);
    const tampered = await request('GET', `/wallets/${walletId}/ledger?cursor=tampered`);
    expect(tampered.status).toBe(400);
    expect(tampered.body).toEqual({ failureCode: 'INVALID_PAYLOAD' });
    const repeated = await request('GET', `/wallets/${walletId}/ledger?cursor=one&cursor=two`);
    expect(repeated.status).toBe(400);
    expect(repeated.body).toEqual({ failureCode: 'INVALID_PAYLOAD' });
    await expectConsistent(walletId, '97.00');

    const before = reconcile?.divergences ?? 0;
    const outboxBefore = await count(
      `select count(*)::text as count from outbox_messages where aggregate_id = $1`,
      [walletId],
    );
    await ownerSql(`update wallets set balance_amount = 1.00 where id = $1`, [walletId]);
    const divergent = await request('POST', `/wallets/${walletId}/reconciliation`, {});
    expect(divergent.status).toBe(200);
    expect(divergent.body.consistent).toBe(false);
    expect(amountOf(divergent.body.storedBalance)).toBe('1.00');
    expect(amountOf(divergent.body.calculatedBalance)).toBe('97.00');
    expect(amountOf(divergent.body.difference)).toBe('-96.00');
    expect(amountOf((await request('GET', `/wallets/${walletId}`)).body.balance)).toBe('1.00');
    expect(reconcile?.divergences).toBe(before + 1);
    expect(await count(`select count(*)::text as count from outbox_messages where aggregate_id = $1`, [walletId])).toBe(outboxBefore);
  });

  test('duas apostas simultâneas de 80.00 sobre 100.00', async () => {
    const walletId = await openWallet('player-race-http', '100.00');
    const [left, right] = await Promise.all([
      wager(walletId, 'player-race-http', 'race-a', 'BET', '80.00'),
      wager(walletId, 'player-race-http', 'race-b', 'BET', '80.00'),
    ]);
    const results = [left, right];
    expect(results.filter((result) => result.status === 200 && result.body.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 422 && result.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    expect(amountOf((await request('GET', `/wallets/${walletId}`)).body.balance)).toBe('20.00');
    const debits = await ownerRows<{ amount: string }>(
      `select amount::text as amount from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits).toEqual([{ amount: '80.00' }]);
    const replayed = await Promise.all([
      wager(walletId, 'player-race-http', 'race-a', 'BET', '80.00'),
      wager(walletId, 'player-race-http', 'race-b', 'BET', '80.00'),
    ]);
    expect(replayed[0]?.body.idempotentReplay).toBe(true);
    expect(replayed[1]?.body.idempotentReplay).toBe(true);
    expect(replayed[0]?.status).toBe(left.status);
    expect(replayed[1]?.status).toBe(right.status);
    expect(amountOf(replayed[0]?.body.balance)).toBe(amountOf(left.body.balance));
    expect(await count(
      `select count(*)::text as count from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`,
      [walletId],
    )).toBe('1');
    await expectConsistent(walletId, '20.00');
    const processed = results.find((result) => result.status === 200);
    expect(await count(
      `select count(*)::text as count from outbox_messages where payload::text like $1`,
      [`%${text(processed?.body.transactionId)}%`],
    )).not.toBe('0');
  }, 20_000);

  test('lock da wallet responde 503 e não grava a aposta', async () => {
    const walletId = await openWallet('player-lock-http', '100.00');
    const held = requireOwner();
    await held.query('begin');
    await held.query('select id from wallets where id = $1 for update', [walletId]);
    try {
      const blocked = await wager(walletId, 'player-lock-http', 'locked-http', 'BET', '10.00');
      expect(blocked.status).toBe(503);
      expect(blocked.body.status).toBeUndefined();
      expect(blocked.body.failureCode).toBeUndefined();
    } finally {
      await held.query('rollback');
    }
    expect(await count(`select count(*)::text as count from wager_transactions where external_transaction_id = $1`, ['locked-http'])).toBe('0');
    expect(amountOf((await request('GET', `/wallets/${walletId}`)).body.balance)).toBe('100.00');
  }, 20_000);

  async function openWallet(playerId: string, amount: string): Promise<string> {
    const created = await request('POST', '/wallets', {
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    });
    expect(created.status).toBe(201);
    return text(created.body.id);
  }

  async function expectConsistent(walletId: string, stored: string): Promise<void> {
    const report = await request('POST', `/wallets/${walletId}/reconciliation`, {});
    expect(report.status).toBe(200);
    expect(report.body.consistent).toBe(true);
    expect(amountOf(report.body.storedBalance)).toBe(stored);
    expect(amountOf(report.body.calculatedBalance)).toBe(stored);
    expect(amountOf(report.body.difference)).toBe('0.00');
  }

  function requireOwner(): Client {
    if (ownerClient === undefined) {
      throw new Error('Owner client was not started');
    }
    return ownerClient;
  }

  async function ownerSql(sql: string, params: unknown[] = []): Promise<void> {
    await requireOwner().query(sql, params);
  }

  async function ownerRows<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await requireOwner().query<T>(sql, params);
    return result.rows;
  }

  async function count(sql: string, params: unknown[]): Promise<string> {
    const rows = await ownerRows<{ count: string }>(sql, params);
    const value = rows[0]?.count;
    if (value === undefined) {
      throw new Error('Count query returned no row');
    }
    return value;
  }
});

interface HttpResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResponse> {
  if (baseUrl === '') {
    throw new Error('HTTP base URL was not published');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textBody = await response.text();
  return {
    status: response.status,
    body: textBody === '' ? {} : (JSON.parse(textBody) as Record<string, unknown>),
  };
}

async function wager(
  walletId: string,
  playerId: string,
  external: string,
  kind: string,
  amount: string,
  reference?: string,
  currency = 'BRL',
): Promise<HttpResponse> {
  return request(
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
      money: { amount, currency },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
    },
    { 'idempotency-key': `prov:${external}` },
  );
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('Expected a string');
  }
  return value;
}

function currencyOf(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a money object');
  }
  const currency = (value as { currency?: unknown }).currency;
  if (typeof currency !== 'string') {
    throw new Error('Money currency is not a string');
  }
  return currency;
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

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected a list');
  }
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Expected an object');
    }
    return item as Record<string, unknown>;
  });
}
