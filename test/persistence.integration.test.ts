import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { classifyPostgresError } from '../src/persistence/postgres-error';
import {
  FinancialStore,
  type SubmitWagerCommand,
  type SubmitWagerPersistenceResult,
} from '../src/persistence/financial-store';
import {
  buildMigrationMikroOrmConfig,
  buildRuntimeMikroOrmConfig,
} from '../src/persistence/mikro-orm.config';
import { uuidV7 } from '../src/persistence/uuid-v7';
import { holdSchemaLock } from './support/database-lock';

const NOW = new Date('2026-10-29T15:00:00.000Z');
describe('Fase 3', () => {
  let release: (() => Promise<void>) | undefined;
  let owner: MikroORM | undefined;
  let app: MikroORM | undefined;
  let store: FinancialStore | undefined;
  let ownerClient: Client | undefined;
  let appClient: Client | undefined;

  beforeAll(async () => {
    release = await holdSchemaLock();
    owner = await MikroORM.init(buildMigrationMikroOrmConfig());
    await owner.migrator.up();
    app = await MikroORM.init(buildRuntimeMikroOrmConfig());
    store = new FinancialStore(app);
    ownerClient = new Client({ connectionString: process.env.DATABASE_URL });
    appClient = new Client({ connectionString: process.env.DATABASE_APP_URL });
    await ownerClient.connect();
    await appClient.connect();
  }, 120_000);

  afterAll(async () => {
    await appClient?.end();
    await ownerClient?.end();
    await app?.close(true);
    await owner?.close(true);
    await release?.();
  });

  test('migration financeira sobe, desce e recria constraints', async () => {
    const migrator = requireOwner().migrator;
    await expectNames();
    await closeApp();
    try {
      await migrator.down({ to: 0 });
      const tables = await ownerTables();
      expect(tables).not.toContain('wallets');
      expect(tables).not.toContain('wallet_ledger_entries');
      const roles = await ownerQuery<{ rolname: string }>(
        `select rolname from pg_roles where rolname = 'wager_app'`,
      );
      expect(roles).toEqual([]);
      await migrator.up();
      await expectNames();
    } finally {
      if (app === undefined) {
        await migrator.up();
        await reconnectApp();
      }
    }
    const types = await ownerQuery<{ data_type: string }>(
      `select data_type
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'wallets'
          and column_name = 'balance_amount'`,
    );
    expect(types[0]?.data_type).toBe('numeric');
    const currency = await ownerQuery<{ data_type: string; character_maximum_length: number }>(
      `select data_type, character_maximum_length
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'wallets'
          and column_name = 'currency'`,
    );
    expect(currency[0]?.data_type).toBe('character varying');
    expect(currency[0]?.character_maximum_length).toBe(3);
    const unvalidated = await ownerQuery<{ conname: string }>(
      `select conname
         from pg_constraint
        where connamespace = 'public'::regnamespace
          and convalidated = false`,
    );
    expect(unvalidated).toEqual([]);
    await ownerSql(
      `alter table wager_transactions add constraint ck_phase3_probe check (status <> 'PROCESSED')`,
    );
    const probe = await ownerQuery<{ convalidated: boolean }>(
      `select convalidated from pg_constraint where conname = 'ck_phase3_probe'`,
    );
    expect(probe[0]?.convalidated).toBe(true);
    await expect(
      ownerSql(
        `insert into wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, attempt_count, created_at
         ) values ($1, 'prov', 'fresh-probe', 'prov:fresh-probe', 'hash', $2, 'player-fresh', 'round-1', 'game-1', 'BET', 1.00, 'BRL', 'PROCESSED', 0, $3)`,
        [uuidV7(), uuidV7(), NOW],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_phase3_probe' });
    await ownerSql(`alter table wager_transactions drop constraint ck_phase3_probe`);
  }, 30_000);

  test('constraints recusam saldo negativo, aritmética inválida e duplicidade', async () => {
    const walletId = uuidV7();
    await expect(
      ownerSql(
        `insert into wallets (
           id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
         ) values ($1, $2, 'BRL', -1, 'BRL', 1, $3, $3)`,
        [walletId, 'negative', NOW],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_wallets_balance_nonnegative' });

    await ownerSql(
      `insert into wallets (
         id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
       ) values ($1, $2, 'BRL', 10.00, 'BRL', 1, $3, $3)`,
      [walletId, 'player-unique', NOW],
    );
    await expect(
      ownerSql(
        `insert into wallets (
           id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
         ) values ($1, $2, 'BRL', 1.00, 'BRL', 1, $3, $3)`,
        [uuidV7(), 'player-unique', NOW],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_wallets_player_currency' });

    await expect(
      ownerSql(
        `insert into wallet_ledger_entries (
           id, wallet_id, transaction_id, direction, amount, currency,
           balance_before, balance_before_currency, balance_after, balance_after_currency, created_at
         ) values ($1, $2, $3, 'CREDIT', 10.00, 'BRL', 0.00, 'BRL', 5.00, 'BRL', $4)`,
        [uuidV7(), walletId, uuidV7(), NOW],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_wallet_ledger_entries_arithmetic' });
  });

  test('ledger é imutável para o papel da aplicação e TRUNCATE é negado', async () => {
    const opened = await requireStore().openWallet({
      id: uuidV7(),
      playerId: 'player-ledger',
      amount: '15.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    if (opened.outcome !== 'created' || opened.entry === null) {
      throw new Error('Opening did not create a ledger entry');
    }
    await expect(
      appSql(`update wallet_ledger_entries set amount = 1.00 where id = $1`, [opened.entry.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'wallet_ledger_entries_append_only' });
    await expect(
      appSql(`delete from wallet_ledger_entries where id = $1`, [opened.entry.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'wallet_ledger_entries_append_only' });
    await expect(appSql(`truncate wallet_ledger_entries`)).rejects.toMatchObject({ code: '42501' });
    const remaining = await appQuery<{ amount: string }>(
      `select amount::text as amount from wallet_ledger_entries where id = $1`,
      [opened.entry.id],
    );
    expect(remaining[0]?.amount).toBe('15.00');
  });

  test('colunas financeiras da transação não mudam e terminal não atualiza', async () => {
    const walletId = uuidV7();
    const playerId = 'player-immutable';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '40.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    const pending = refund(walletId, playerId, 'missing-ref', 'bet-missing', '10.00');
    const stored = await requireStore().submitWager(pending);
    expect(stored.outcome).toBe('applied');
    if (stored.outcome !== 'applied') {
      return;
    }
    expect(stored.transaction.status).toBe('PENDING_REFERENCE');
    expect(stored.transaction.attemptCount).toBe(0);
    const schedule = await appQuery<{ next_attempt_at: Date; deadline_at: Date; attempt_count: number }>(
      `select next_attempt_at, deadline_at, attempt_count from wager_transactions where id = $1`,
      [pending.id],
    );
    const clock = await appQuery<{ now: Date }>(`select now() as now`);
    const next = schedule[0]?.next_attempt_at;
    const deadline = schedule[0]?.deadline_at;
    const databaseNow = clock[0]?.now;
    if (next === undefined || deadline === undefined || databaseNow === undefined) {
      throw new Error('Pending schedule was not stored');
    }
    expect(schedule[0]?.attempt_count).toBe(0);
    const ttl = Number(process.env.REFERENCE_TTL_MS ?? 15 * 60 * 1000);
    expect(deadline.getTime() - next.getTime()).toBe(ttl);
    expect(Math.abs(next.getTime() - databaseNow.getTime())).toBeLessThan(5_000);
    expect(next.toISOString()).not.toBe(NOW.toISOString());
    await expect(
      appSql(`update wager_transactions set amount = 11.00 where id = $1`, [pending.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'wager_transactions_immutable' });
    const amount = await appQuery<{ amount: string }>(
      `select amount::text as amount from wager_transactions where id = $1`,
      [pending.id],
    );
    expect(amount[0]?.amount).toBe('10.00');

    const betCommand = bet(walletId, playerId, 'immutable-bet', '10.00');
    const processed = await requireStore().submitWager(betCommand);
    expect(processed.outcome).toBe('applied');
    await expect(
      appSql(`update wager_transactions set status = 'REJECTED' where id = $1`, [betCommand.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'wager_transactions_immutable' });
    await expect(
      appSql(`delete from wager_transactions where id = $1`, [betCommand.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'wager_transactions_immutable' });
  });

  test('numeric volta como string, inclusive acima de 2^53', async () => {
    const walletId = uuidV7();
    const opened = await requireStore().openWallet({
      id: walletId,
      playerId: 'player-precision',
      amount: '9007199254740993.99',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    expect(opened.outcome).toBe('created');
    const loaded = await requireStore().loadWallet(walletId);
    const amount = loaded?.balance.toJSON().amount;
    expect(typeof amount).toBe('string');
    expect(amount).toBe('9007199254740993.99');
    const raw = await appQuery<{ balance_amount: string }>(
      `select balance_amount::text as balance_amount from wallets where id = $1`,
      [walletId],
    );
    expect(raw[0]?.balance_amount).toBe('9007199254740993.99');
    const transactionId = opened.outcome === 'created' ? opened.transaction?.id : undefined;
    const entry = transactionId === undefined ? null : await requireStore().loadLedger(transactionId);
    expect(entry?.money.toJSON().amount).toBe('9007199254740993.99');
    expect(entry?.isBalanced()).toBe(true);
    expect(loaded?.version).toBe(1);
  });

  test('abertura zero não grava transação e abertura duplicada é conflito', async () => {
    const first = await requireStore().openWallet({
      id: uuidV7(),
      playerId: 'player-zero',
      amount: '0.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    expect(first.outcome).toBe('created');
    if (first.outcome === 'created') {
      expect(first.transaction).toBeNull();
      expect(first.entry).toBeNull();
      expect(first.wallet.balance.toJSON().amount).toBe('0.00');
    }
    const duplicate = await requireStore().openWallet({
      id: uuidV7(),
      playerId: 'player-zero',
      amount: '0.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    expect(duplicate).toEqual({ outcome: 'conflict', failureCode: 'WALLET_ALREADY_EXISTS' });
  });

  test('wallet ausente persiste rejeição sem ledger', async () => {
    const command = bet(uuidV7(), 'missing-player', 'missing-wallet', '10.00');
    command.inbox = { messageId: uuidV7(), payloadHash: 'missing-wallet' };
    const result = await requireStore().submitWager(command);
    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      return;
    }
    expect(result.transaction.failureCode).toBe('WALLET_NOT_FOUND');
    expect(result.transaction.observedBalance).toBeUndefined();
    expect(await requireStore().loadLedger(command.id)).toBeNull();
    expect(await count(`select count(*)::text as count from inbox_messages where message_id = $1`, [command.inbox.messageId])).toBe('1');
    const events = await count(
      `select count(*)::text as count from outbox_messages where aggregate_id = $1`,
      [command.walletId],
    );
    expect(events).toBe('1');
  });

  test('rollback desfaz saldo, ledger, transação, inbox e outbox', async () => {
    const walletId = uuidV7();
    const playerId = 'player-rollback';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '50.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    const command = bet(walletId, playerId, 'rollback-bet', '5.00');
    command.inbox = { messageId: uuidV7(), payloadHash: 'hash-rollback' };
    await requireOwnerClient().query('revoke insert on outbox_messages from wager_app');
    try {
      await expect(requireStore().submitWager(command)).rejects.toThrow();
    } finally {
      await requireOwnerClient().query('grant insert on outbox_messages to wager_app');
    }
    const loaded = await requireStore().loadWallet(walletId);
    expect(loaded?.balance.toJSON().amount).toBe('50.00');
    expect(await count(`select count(*)::text as count from wager_transactions where id = $1`, [command.id])).toBe('0');
    expect(await count(`select count(*)::text as count from wallet_ledger_entries where transaction_id = $1`, [command.id])).toBe('0');
    expect(await count(`select count(*)::text as count from inbox_messages where message_id = $1`, [command.inbox.messageId])).toBe('0');
  });

  test('aposta, replay e conflito de idempotência não duplicam o ledger', async () => {
    const walletId = uuidV7();
    const playerId = 'player-idem';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '100.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    const command = bet(walletId, playerId, 'idem-bet', '30.00');
    const first = await requireStore().submitWager(command);
    expect(first.outcome).toBe('applied');
    const replay = await requireStore().submitWager(command);
    expect(replay.outcome).toBe('replay');
    expect(await count(`select count(*)::text as count from wallet_ledger_entries where transaction_id = $1`, [command.id])).toBe('1');
    const later = bet(walletId, playerId, 'idem-later', '10.00');
    expect((await requireStore().submitWager(later)).outcome).toBe('applied');
    const frozen = await requireStore().submitWager(command);
    expect(frozen.outcome).toBe('replay');
    if (first.outcome === 'applied' && frozen.outcome === 'replay') {
      expect(frozen.transaction.observedBalance?.toJSON().amount).toBe(
        first.transaction.observedBalance?.toJSON().amount,
      );
      expect(frozen.transaction.observedBalance?.toJSON().amount).toBe('70.00');
    }
    expect((await requireStore().loadWallet(walletId))?.balance.toJSON().amount).toBe('60.00');
    const mismatch = bet(walletId, playerId, 'idem-bet', '31.00');
    const conflict = await requireStore().submitWager(mismatch);
    expect(conflict).toEqual({ outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(await count(`select count(*)::text as count from wager_transactions where idempotency_key = $1`, [command.idempotencyKey])).toBe('1');

    await ownerSql(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, attempt_count, created_at
       ) values ($1, 'prov', 'legacy-ext', 'legacy:legacy-ext', 'hash', $2, $3, 'round-1', 'game-1', 'BET', 1.00, 'BRL', 'PROCESSED', 0, $4)`,
      [uuidV7(), walletId, playerId, NOW],
    );
    const keyMismatch = bet(walletId, playerId, 'legacy-ext', '1.00');
    expect(await requireStore().submitWager(keyMismatch)).toEqual({
      outcome: 'conflict',
      failureCode: 'IDEMPOTENCY_KEY_MISMATCH',
    });
  });

  test('segunda reversão PROCESSED é rejeitada e não credita de novo', async () => {
    const walletId = uuidV7();
    const playerId = 'player-reversal';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '100.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    const wager = bet(walletId, playerId, 'reversal-bet', '25.00');
    expect((await requireStore().submitWager(wager)).outcome).toBe('applied');
    const firstRefund = refund(walletId, playerId, 'refund-1', 'reversal-bet', '25.00');
    const refunded = await requireStore().submitWager(firstRefund);
    expect(refunded.outcome).toBe('applied');
    const second = refund(walletId, playerId, 'refund-2', 'reversal-bet', '25.00');
    const rejected = await requireStore().submitWager(second);
    expect(rejected.outcome).toBe('rejected');
    if (rejected.outcome === 'rejected') {
      expect(rejected.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    }
    const loaded = await requireStore().loadWallet(walletId);
    expect(loaded?.balance.toJSON().amount).toBe('100.00');
    expect(await count(
      `select count(*)::text as count
         from wallet_ledger_entries
        where wallet_id = $1 and direction = 'CREDIT' and amount = 25.00`,
      [walletId],
    )).toBe('1');
  });

  test('constraint desconhecida grava FAILED sem saldo, ledger ou outbox', async () => {
    const walletId = uuidV7();
    const playerId = 'player-corrupt';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '100.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    await ownerSql(
      `alter table wager_transactions add constraint ck_phase3_probe check (status <> 'PROCESSED') not valid`,
    );
    const command = bet(walletId, playerId, 'corrupt-bet', '10.00');
    try {
      const result = await requireStore().submitWager(command);
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.transaction.status).toBe('FAILED');
        expect(result.transaction.failureCode).toBe('PERSISTENT_STATE_CORRUPT');
      }
      expect((await requireStore().loadWallet(walletId))?.balance.toJSON().amount).toBe('100.00');
      expect(await requireStore().loadLedger(command.id)).toBeNull();
      expect(await count(
        `select count(*)::text as count from outbox_messages where payload::text like $1`,
        [`%${command.id}%`],
      )).toBe('0');
    } finally {
      await ownerSql(`alter table wager_transactions drop constraint if exists ck_phase3_probe`);
    }
  });

  test('lock da wallet em outra sessão é transitório e não rejeita a aposta', async () => {
    const walletId = uuidV7();
    const playerId = 'player-lock';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '100.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    const held = requireOwnerClient();
    await held.query('begin');
    await held.query('select id from wallets where id = $1 for update', [walletId]);
    const command = bet(walletId, playerId, 'locked-bet', '10.00');
    let thrown: unknown;
    try {
      await requireStore().submitWager(command);
    } catch (error) {
      thrown = error;
    } finally {
      await held.query('rollback');
    }
    expect(classifyPostgresError(thrown).kind).toBe('transient');
    expect(await count(`select count(*)::text as count from wager_transactions where id = $1`, [command.id])).toBe('0');
    expect((await requireStore().loadWallet(walletId))?.balance.toJSON().amount).toBe('100.00');
  }, 20_000);

  test('duas apostas simultâneas de 80.00 sobre 100.00', async () => {
    const walletId = uuidV7();
    const playerId = 'player-race';
    await requireStore().openWallet({
      id: walletId,
      playerId,
      amount: '100.00',
      currency: 'BRL',
      now: NOW,
      correlationId: uuidV7(),
    });
    const first = bet(walletId, playerId, 'race-a', '80.00');
    const second = bet(walletId, playerId, 'race-b', '80.00');
    const results = await Promise.all([
      requireStore().submitWager(first),
      requireStore().submitWager(second),
    ]);
    const processed = results.filter((result) => result.outcome === 'applied');
    const rejected = results.filter(isRejectedInsufficient);
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loaded = await requireStore().loadWallet(walletId);
    expect(loaded?.balance.toJSON().amount).toBe('20.00');
    const debits = await appQuery<{ direction: string; amount: string }>(
      `select direction, amount::text as amount
         from wallet_ledger_entries
        where wallet_id = $1 and direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits).toEqual([{ direction: 'DEBIT', amount: '80.00' }]);
    const replayed = await Promise.all([
      requireStore().submitWager(first),
      requireStore().submitWager(second),
    ]);
    expect(replayed[0]?.outcome).toBe('replay');
    expect(replayed[1]?.outcome).toBe('replay');
    if (
      replayed[0]?.outcome === 'replay' &&
      replayed[1]?.outcome === 'replay' &&
      results[0]?.outcome !== 'conflict' &&
      results[1]?.outcome !== 'conflict'
    ) {
      expect(replayed[0].transaction.status).toBe(results[0].transaction.status);
      expect(replayed[1].transaction.status).toBe(results[1].transaction.status);
      expect(replayed[0].transaction.observedBalance?.toJSON().amount).toBe(
        results[0].transaction.observedBalance?.toJSON().amount,
      );
      expect(replayed[1].transaction.failureCode).toBe(results[1].transaction.failureCode);
    }
    const afterReplay = await appQuery<{ direction: string; amount: string }>(
      `select direction, amount::text as amount
         from wallet_ledger_entries
        where wallet_id = $1 and direction = 'DEBIT'`,
      [walletId],
    );
    expect(afterReplay).toEqual([{ direction: 'DEBIT', amount: '80.00' }]);
    const processedTx = results.find((result) => result.outcome === 'applied');
    if (processedTx?.outcome === 'applied') {
      const entry = await requireStore().loadLedger(processedTx.transaction.id);
      expect(entry?.direction).toBe('DEBIT');
      expect(entry?.money.toJSON().amount).toBe('80.00');
      expect(entry?.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry?.balanceAfter.toJSON().amount).toBe('20.00');
      expect(entry?.isBalanced()).toBe(true);
      expect(loaded?.balance.toJSON().amount).toBe(entry?.balanceAfter.toJSON().amount);
      const again = await requireStore().loadWager(processedTx.transaction.id);
      expect(again?.status).toBe('PROCESSED');
      expect(again?.money.toJSON().amount).toBe('80.00');
    }
  }, 20_000);

  async function closeApp(): Promise<void> {
    await appClient?.end();
    appClient = undefined;
    await app?.close(true);
    app = undefined;
  }

  async function reconnectApp(): Promise<void> {
    app = await MikroORM.init(buildRuntimeMikroOrmConfig());
    store = new FinancialStore(app);
    appClient = new Client({ connectionString: process.env.DATABASE_APP_URL });
    await appClient.connect();
  }

  function requireOwner(): MikroORM {
    if (owner === undefined) {
      throw new Error('Owner ORM was not started');
    }
    return owner;
  }

  function requireStore(): FinancialStore {
    if (store === undefined) {
      throw new Error('Store was not started');
    }
    return store;
  }

  function requireOwnerClient(): Client {
    if (ownerClient === undefined) {
      throw new Error('Owner client was not started');
    }
    return ownerClient;
  }

  async function ownerSql(sql: string, params: unknown[] = []): Promise<void> {
    await requireOwnerClient().query(sql, params);
  }

  async function appSql(sql: string, params: unknown[] = []): Promise<void> {
    if (appClient === undefined) {
      throw new Error('App client was not started');
    }
    await appClient.query(sql, params);
  }

  async function ownerQuery<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    const result = await requireOwnerClient().query<T>(sql);
    return result.rows;
  }

  async function appQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (appClient === undefined) {
      throw new Error('App client was not started');
    }
    const result = await appClient.query<T>(sql, params);
    return result.rows;
  }

  async function ownerTables(): Promise<string[]> {
    const rows = await ownerQuery<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    return rows.map((row) => row.table_name);
  }

  async function expectNames(): Promise<void> {
    const constraints = await ownerQuery<{ conname: string }>(
      `select conname from pg_constraint where connamespace = 'public'::regnamespace`,
    );
    const names = constraints.map((row) => row.conname);
    for (const name of [
      'uq_wallets_player_currency',
      'ck_wallets_balance_nonnegative',
      'uq_wager_transactions_idempotency_key',
      'uq_wager_transactions_provider_external',
      'ck_wallet_ledger_entries_arithmetic',
      'ck_wallet_ledger_entries_balance_before',
      'ck_wallet_ledger_entries_balance_after',
    ]) {
      expect(names).toContain(name);
    }
    const indexes = await ownerQuery<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'`,
    );
    const indexNames = indexes.map((row) => row.indexname);
    expect(indexNames).toContain('ux_reversal_once');
    expect(indexNames).toContain('ix_wager_transactions_pending');
    expect(indexNames).toContain('ix_outbox_messages_pending');
  }

  async function count(sql: string, params: unknown[]): Promise<string> {
    const rows = await appQuery<{ count: string }>(sql, params);
    const value = rows[0]?.count;
    if (value === undefined) {
      throw new Error('Count query returned no row');
    }
    return value;
  }
});

function bet(walletId: string, playerId: string, external: string, amount: string): SubmitWagerCommand {
  return {
    id: uuidV7(),
    providerId: 'prov',
    externalTransactionId: external,
    idempotencyKey: `prov:${external}`,
    walletId,
    playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    amount,
    currency: 'BRL',
    now: NOW,
    correlationId: uuidV7(),
  };
}

function refund(
  walletId: string,
  playerId: string,
  external: string,
  reference: string,
  amount: string,
): SubmitWagerCommand {
  return {
    ...bet(walletId, playerId, external, amount),
    kind: 'REFUND',
    referenceExternalTransactionId: reference,
  };
}

function isRejectedInsufficient(result: SubmitWagerPersistenceResult): boolean {
  return result.outcome === 'rejected' && result.transaction.failureCode === 'INSUFFICIENT_FUNDS';
}
