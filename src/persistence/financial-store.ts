import { LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { DomainError } from '../domain/domain-error';
import type { FailureCode } from '../domain/failure-code';
import { IntegrationEvent } from '../domain/events/integration-event';
import { WagerTransactionRejected } from '../domain/events/wager-events';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { Money } from '../domain/money/money';
import { applyWager } from '../domain/wager/apply-wager';
import { resolveIdempotency } from '../domain/wager/idempotency';
import {
  WagerTransaction,
  type WagerTransactionKind,
} from '../domain/wager/wager-transaction';
import { openWallet } from '../domain/wallet/open-wallet';
import { Wallet } from '../domain/wallet/wallet';
import {
  backoffDelayMs,
  claimLeaseMs,
  outboxBackoffBaseMs,
  outboxBackoffCapMs,
  pendingBackoffBaseMs,
  pendingBackoffCapMs,
  pendingMaxAttempts,
} from '../config/async-config';
import { classifyPostgresError, persistsAsFailed } from './postgres-error';
import {
  InboxMessageRecord,
  IngressRejectRecord,
  OutboxMessageRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
  WagerTransactionRecord,
} from './records';
import { uuidV7 } from './uuid-v7';

const CONSUMER_NAME = 'wager-transactions';
const DEFAULT_REFERENCE_TTL_MS = 15 * 60 * 1000;

export interface OpenWalletCommand {
  id: string;
  playerId: string;
  amount: string;
  currency: string;
  now: Date;
  correlationId: string;
}

export interface SubmitWagerCommand {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, 'OPENING'>;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  now: Date;
  correlationId: string;
  inbox?: { messageId: string; payloadHash: string };
}

export type OpenWalletPersistenceResult =
  | {
      outcome: 'created';
      wallet: Wallet;
      transaction: WagerTransaction | null;
      entry: WalletLedgerEntry | null;
    }
  | { outcome: 'conflict'; failureCode: 'WALLET_ALREADY_EXISTS' };

export type SubmitWagerPersistenceResult =
  | {
      outcome: 'applied' | 'replay' | 'rejected' | 'failed';
      transaction: WagerTransaction;
      wallet: Wallet | null;
      entry: WalletLedgerEntry | null;
      inbox?: 'recorded' | 'duplicate';
    }
  | {
      outcome: 'conflict';
      failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'IDEMPOTENCY_KEY_MISMATCH';
      inbox?: 'mismatch';
    }
  | { outcome: 'duplicate' }
  | { outcome: 'inbox-held' };

export interface ClaimedOutbox {
  eventId: string;
  aggregateId: string;
  body: string;
}

@Injectable()
export class FinancialStore {
  constructor(private readonly orm: MikroORM) {}

  async openWallet(command: OpenWalletCommand): Promise<OpenWalletPersistenceResult> {
    const em = this.orm.em.fork();
    try {
      return await em.transactional(async (tx) => {
        await setLocalTimeouts(tx);
        const opened = openWallet({
          id: command.id,
          playerId: command.playerId,
          initialBalance: Money.from({ amount: command.amount, currency: command.currency }),
          transactionId: uuidV7(command.now.getTime()),
          entryId: uuidV7(command.now.getTime() + 1),
          now: command.now,
          correlationId: command.correlationId,
          nextEventId: () => uuidV7(),
        });
        await insertWallet(tx, opened.wallet);
        if (opened.transaction !== null) {
          await insertWager(tx, opened.transaction);
        }
        if (opened.entry !== null) {
          await insertLedger(tx, opened.entry);
        }
        await insertEvents(tx, opened.events);
        return {
          outcome: 'created' as const,
          wallet: opened.wallet,
          transaction: opened.transaction,
          entry: opened.entry,
        };
      });
    } catch (error) {
      const classified = classifyPostgresError(error);
      if (classified.kind === 'unique' && classified.name === 'uq_wallets_player_currency') {
        return { outcome: 'conflict', failureCode: 'WALLET_ALREADY_EXISTS' };
      }
      throw error;
    }
  }

  async submitWager(command: SubmitWagerCommand): Promise<SubmitWagerPersistenceResult> {
    const em = this.orm.em.fork();
    try {
      return await em.transactional((tx) => this.applySubmission(tx, command));
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      return this.recover(command, error);
    }
  }

  async loadWallet(id: string): Promise<Wallet | null> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id });
    return record === null ? null : walletFrom(record);
  }

  async loadWager(id: string): Promise<WagerTransaction | null> {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, { id });
    return record === null ? null : wagerFrom(record);
  }

  async loadLedger(transactionId: string): Promise<WalletLedgerEntry | null> {
    const record = await this.orm.em.fork().findOne(WalletLedgerEntryRecord, { transactionId });
    return record === null ? null : ledgerFrom(record);
  }

  async loadWagerByPair(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return findByPair(this.orm.em.fork(), providerId, externalTransactionId);
  }

  async listLedger(
    walletId: string,
    after: { createdAt: string; id: string } | null,
    limit: number,
  ): Promise<Array<{ entry: WalletLedgerEntry; cursorCreatedAt: string }>> {
    const rows = await this.orm.em.fork().getConnection().execute<Array<LedgerRow & { created_at_cursor: string }>>(
      `select id,
              wallet_id,
              transaction_id,
              direction,
              amount::text as amount,
              currency,
              balance_before::text as balance_before,
              balance_before_currency,
              balance_after::text as balance_after,
              balance_after_currency,
              created_at,
              created_at::text as created_at_cursor
         from wallet_ledger_entries
        where wallet_id = ?
          and (
            cast(? as timestamptz) is null
            or (created_at, id) > (cast(? as timestamptz), cast(? as uuid))
          )
        order by created_at, id
        limit ?`,
      [walletId, after?.createdAt ?? null, after?.createdAt ?? null, after?.id ?? null, limit],
    );
    return rows.map((row) => ({ entry: ledgerFromRow(row), cursorCreatedAt: row.created_at_cursor }));
  }

  /**
   * Trava a wallet e lê o ledger inteiro. Não grava saldo, lançamento nem outbox.
   */
  async readForReconciliation(
    walletId: string,
  ): Promise<{ wallet: Wallet; entries: WalletLedgerEntry[] } | null> {
    const em = this.orm.em.fork();
    return em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      const wallet = await lockWallet(tx, walletId);
      if (wallet === null) {
        return null;
      }
      const rows = await tx.execute<LedgerRow[]>(
        `select id,
                wallet_id,
                transaction_id,
                direction,
                amount::text as amount,
                currency,
                balance_before::text as balance_before,
                balance_before_currency,
                balance_after::text as balance_after,
                balance_after_currency,
                created_at
           from wallet_ledger_entries
          where wallet_id = ?
          order by created_at, id`,
        [walletId],
      );
      return { wallet, entries: rows.map((row) => ledgerFromRow(row)) };
    });
  }

  private async applySubmission(
    tx: EntityManager,
    command: SubmitWagerCommand,
  ): Promise<SubmitWagerPersistenceResult> {
    await setLocalTimeouts(tx);
    let wallet = await lockWallet(tx, command.walletId);
    if (wallet === null) {
      wallet = await lockWallet(tx, command.walletId);
    }
    const decision = await readIdempotency(tx, command);
    if (decision.kind === 'replay') {
      const inbox = await ensureInbox(tx, command);
      const absorbed = absorbInbox(inbox, { transaction: decision.transaction, wallet });
      if (absorbed !== null) {
        return absorbed;
      }
      return {
        outcome: 'replay',
        transaction: decision.transaction,
        wallet,
        entry: null,
        ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
      };
    }
    if (decision.kind === 'conflict') {
      const inbox = await ensureInbox(tx, command);
      const absorbed = absorbInbox(inbox, null);
      if (absorbed !== null) {
        return absorbed;
      }
      return decision.result;
    }
    const inbox = await ensureInbox(tx, command);
    const absorbed = absorbInbox(inbox, null);
    if (absorbed !== null) {
      return absorbed;
    }
    const transaction = WagerTransaction.create({
      id: command.id,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from({ amount: command.amount, currency: command.currency }),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: command.now,
    });
    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? null
        : await findByPair(tx, command.providerId, transaction.referenceExternalTransactionId);
    const processedReversal =
      reference === null ? null : await findProcessedReversal(tx, reference.id);
    const versionBefore = wallet?.version;
    const applied = applyWager({
      transaction,
      wallet,
      reference,
      processedReversal,
      now: command.now,
      deadlineAt: command.now,
      entryId: uuidV7(),
      correlationId: command.correlationId,
      nextEventId: () => uuidV7(),
    });
    if (applied.transaction.status === 'PENDING_REFERENCE') {
      const schedule = await pendingSchedule(tx);
      applied.transaction.alignPendingSchedule(schedule.nextAttemptAt, schedule.deadlineAt);
    }
    if (applied.entry !== null) {
      await insertLedger(tx, applied.entry);
    }
    if (applied.wallet !== null && versionBefore !== undefined && applied.wallet.version !== versionBefore) {
      await updateWallet(tx, applied.wallet, versionBefore);
    }
    await insertWager(tx, applied.transaction);
    await insertEvents(tx, applied.events);
    return {
      outcome: applied.transaction.status === 'REJECTED' ? 'rejected' : 'applied',
      transaction: applied.transaction,
      wallet: applied.wallet,
      entry: applied.entry,
      ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
    };
  }

  private async recover(
    command: SubmitWagerCommand,
    error: unknown,
  ): Promise<SubmitWagerPersistenceResult> {
    const classified = classifyPostgresError(error);
    if (
      classified.kind === 'transient' ||
      classified.kind === 'programming' ||
      classified.kind === 'other'
    ) {
      throw error;
    }
    if (classified.kind === 'unique') {
      if (
        classified.name === 'uq_wager_transactions_idempotency_key' ||
        classified.name === 'uq_wager_transactions_provider_external' ||
        classified.name === 'uq_wallet_ledger_entries_transaction' ||
        classified.name === 'inbox_messages_pkey'
      ) {
        return this.reread(command);
      }
      if (classified.name === 'ux_reversal_once') {
        return this.persistRejection(command, 'REFERENCE_ALREADY_REVERSED');
      }
    }
    if (classified.kind === 'balance-check') {
      const code =
        command.kind === 'ROLLBACK' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS';
      return this.persistRejection(command, code);
    }
    if (classified.kind === 'overflow') {
      return this.persistRejection(command, 'AMOUNT_OVERFLOW');
    }
    if (persistsAsFailed(classified)) {
      return this.persistFailed(command);
    }
    throw error;
  }

  private async reread(command: SubmitWagerCommand): Promise<SubmitWagerPersistenceResult> {
    const em = this.orm.em.fork();
    return em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      const wallet = await lockWallet(tx, command.walletId);
      const decision = await readIdempotency(tx, command);
      if (decision.kind === 'replay') {
        const inbox = await ensureInbox(tx, command);
        const absorbed = absorbInbox(inbox, { transaction: decision.transaction, wallet });
        if (absorbed !== null) {
          return absorbed;
        }
        return {
          outcome: 'replay' as const,
          transaction: decision.transaction,
          wallet,
          entry: null,
          ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
        };
      }
      if (decision.kind === 'conflict') {
        const inbox = await ensureInbox(tx, command);
        const absorbed = absorbInbox(inbox, null);
        if (absorbed !== null) {
          return absorbed;
        }
        return decision.result;
      }
      const inbox = await ensureInbox(tx, command);
      const absorbed = absorbInbox(inbox, null);
      if (absorbed !== null) {
        return absorbed;
      }
      throw new Error('Persistence conflict could not be reread');
    });
  }

  private async persistRejection(
    command: SubmitWagerCommand,
    failureCode: FailureCode,
  ): Promise<SubmitWagerPersistenceResult> {
    const em = this.orm.em.fork();
    try {
      return await em.transactional(async (tx) => {
        await setLocalTimeouts(tx);
        let wallet = await lockWallet(tx, command.walletId);
        if (wallet === null) {
          wallet = await lockWallet(tx, command.walletId);
        }
        const decision = await readIdempotency(tx, command);
        if (decision.kind === 'replay') {
          const inbox = await ensureInbox(tx, command);
          const absorbed = absorbInbox(inbox, { transaction: decision.transaction, wallet });
          if (absorbed !== null) {
            return absorbed;
          }
          return {
            outcome: 'replay' as const,
            transaction: decision.transaction,
            wallet,
            entry: null,
            ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
          };
        }
        if (decision.kind === 'conflict') {
          const inbox = await ensureInbox(tx, command);
          const absorbed = absorbInbox(inbox, null);
          if (absorbed !== null) {
            return absorbed;
          }
          return decision.result;
        }
        const inbox = await ensureInbox(tx, command);
        const absorbed = absorbInbox(inbox, null);
        if (absorbed !== null) {
          return absorbed;
        }
        const transaction = WagerTransaction.create(commandToCreate(command));
        transaction.reject(failureCode, command.now, wallet?.balance);
        await insertWager(tx, transaction);
        await insertEvents(tx, [
          WagerTransactionRejected.create({
            eventId: uuidV7(),
            aggregateId: command.walletId,
            correlationId: command.correlationId,
            causationId: transaction.id,
            occurredAt: command.now,
            data: {
              transactionId: transaction.id,
              walletId: command.walletId,
              playerId: command.playerId,
              providerId: command.providerId,
              kind: command.kind,
              failureCode,
              money: transaction.money.toJSON(),
              observedBalance: wallet?.balance.toJSON(),
            },
          }),
        ]);
        return {
          outcome: 'rejected' as const,
          transaction,
          wallet,
          entry: null,
          ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
        };
      });
    } catch (error) {
      const classified = classifyPostgresError(error);
      if (
        classified.kind === 'unique' &&
        (classified.name === 'uq_wager_transactions_idempotency_key' ||
          classified.name === 'uq_wager_transactions_provider_external')
      ) {
        return this.reread(command);
      }
      throw error;
    }
  }

  private async persistFailed(command: SubmitWagerCommand): Promise<SubmitWagerPersistenceResult> {
    const em = this.orm.em.fork();
    try {
      return await em.transactional(async (tx) => {
        await setLocalTimeouts(tx);
        let wallet = await lockWallet(tx, command.walletId);
        if (wallet === null) {
          wallet = await lockWallet(tx, command.walletId);
        }
        const decision = await readIdempotency(tx, command);
        if (decision.kind === 'replay') {
          const inbox = await ensureInbox(tx, command);
          const absorbed = absorbInbox(inbox, { transaction: decision.transaction, wallet });
          if (absorbed !== null) {
            return absorbed;
          }
          return {
            outcome: 'replay' as const,
            transaction: decision.transaction,
            wallet,
            entry: null,
            ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
          };
        }
        if (decision.kind === 'conflict') {
          const inbox = await ensureInbox(tx, command);
          const absorbed = absorbInbox(inbox, null);
          if (absorbed !== null) {
            return absorbed;
          }
          return decision.result;
        }
        const inbox = await ensureInbox(tx, command);
        const absorbed = absorbInbox(inbox, null);
        if (absorbed !== null) {
          return absorbed;
        }
        const transaction = WagerTransaction.create(commandToCreate(command));
        transaction.fail('PERSISTENT_STATE_CORRUPT', command.now);
        await insertWager(tx, transaction);
        return {
          outcome: 'failed' as const,
          transaction,
          wallet,
          entry: null,
          ...(inbox === 'recorded' ? { inbox: 'recorded' as const } : {}),
        };
      });
    } catch (error) {
      const classified = classifyPostgresError(error);
      if (
        classified.kind === 'unique' &&
        (classified.name === 'uq_wager_transactions_idempotency_key' ||
          classified.name === 'uq_wager_transactions_provider_external')
      ) {
        return this.reread(command);
      }
      throw error;
    }
  }

  async recordIngressReject(messageId: string, failureCode: string, payloadHash: string | null): Promise<void> {
    const em = this.orm.em.fork();
    await em.insert(IngressRejectRecord, {
      id: uuidV7(),
      consumerName: CONSUMER_NAME,
      messageId,
      payloadHash,
      failureCode,
      receivedAt: new Date(),
    });
  }

  async claimOutbox(): Promise<ClaimedOutbox | null> {
    const em = this.orm.em.fork();
    return em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      const rows = await tx.execute<Array<{ id: string; aggregate_id: string; payload: unknown }>>(
        `with claimed as (
           select id
             from outbox_messages candidate
            where published_at is null
              and (next_attempt_at is null or next_attempt_at <= now())
              and not exists (
                select 1
                  from outbox_messages older
                 where older.aggregate_id = candidate.aggregate_id
                   and older.published_at is null
                   and (older.occurred_at, older.id) < (candidate.occurred_at, candidate.id)
              )
            order by occurred_at, id
            for update skip locked
            limit 1
         )
         update outbox_messages
            set next_attempt_at = now() + (interval '1 millisecond' * ?)
           from claimed
          where outbox_messages.id = claimed.id
         returning outbox_messages.id, outbox_messages.aggregate_id, outbox_messages.payload`,
        [claimLeaseMs()],
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        eventId: row.id,
        aggregateId: row.aggregate_id,
        body: typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
      };
    });
  }

  async markOutboxPublished(eventId: string): Promise<void> {
    const em = this.orm.em.fork();
    await em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      await tx.execute(
        `update outbox_messages
            set published_at = now()
          where id = ?
            and published_at is null`,
        [eventId],
      );
    });
  }

  async rescheduleOutbox(eventId: string): Promise<void> {
    const em = this.orm.em.fork();
    await em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      await tx.execute(
        `update outbox_messages
            set attempts = attempts + 1,
                next_attempt_at = now() + (
                  interval '1 millisecond' * least(?::numeric, ?::numeric * power(2, attempts))
                )
          where id = ?
            and published_at is null`,
        [outboxBackoffCapMs(), outboxBackoffBaseMs(), eventId],
      );
    });
  }

  async readOutboxLag(): Promise<{ count: number; lagSeconds: number }> {
    const rows = await this.orm.em.fork().getConnection().execute<
      Array<{ count: string; lag_seconds: string | null }>
    >(
      `select count(*)::text as count,
              extract(epoch from (now() - min(occurred_at)))::text as lag_seconds
         from outbox_messages
        where published_at is null`,
    );
    const row = rows[0];
    return {
      count: Number(row?.count ?? '0'),
      lagSeconds: row?.lag_seconds === null || row?.lag_seconds === undefined ? 0 : Number(row.lag_seconds),
    };
  }

  async claimPendingReference(): Promise<string | null> {
    const em = this.orm.em.fork();
    return em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      const rows = await tx.execute<Array<{ id: string }>>(
        `with claimed as (
           select id
             from wager_transactions
            where status = 'PENDING_REFERENCE'
              and next_attempt_at <= now()
            order by next_attempt_at, id
            for update skip locked
            limit 1
         )
         update wager_transactions
            set next_attempt_at = now() + (interval '1 millisecond' * ?)
           from claimed
          where wager_transactions.id = claimed.id
         returning wager_transactions.id`,
        [claimLeaseMs()],
      );
      return rows[0]?.id ?? null;
    });
  }

  async resolvePendingReference(id: string): Promise<'resolved' | 'waiting' | 'rejected' | 'skipped'> {
    const em = this.orm.em.fork();
    return em.transactional(async (tx) => {
      await setLocalTimeouts(tx);
      const loaded = await tx.findOne(WagerTransactionRecord, { id });
      if (loaded === null || loaded.status !== 'PENDING_REFERENCE') {
        return 'skipped';
      }
      const walletId = loaded.walletId;
      let wallet = await lockWallet(tx, walletId);
      if (wallet === null) {
        wallet = await lockWallet(tx, walletId);
      }
      const again = await tx.findOne(WagerTransactionRecord, { id });
      if (again === null || again.status !== 'PENDING_REFERENCE') {
        return 'skipped';
      }
      const transaction = wagerFrom(again);
      const clock = await postgresNow(tx);
      const reference =
        transaction.referenceExternalTransactionId === undefined
          ? null
          : await findByPair(tx, transaction.providerId, transaction.referenceExternalTransactionId);
      const processedReversal = reference === null ? null : await findProcessedReversal(tx, reference.id);
      const versionBefore = wallet?.version;
      const applied = applyWager({
        transaction,
        wallet,
        reference,
        processedReversal,
        now: clock,
        deadlineAt: transaction.deadlineAt ?? clock,
        entryId: uuidV7(),
        correlationId: uuidV7(),
        nextEventId: () => uuidV7(),
      });
      if (applied.transaction.status === 'PENDING_REFERENCE') {
        const deadline = transaction.deadlineAt;
        const exhausted =
          transaction.attemptCount >= pendingMaxAttempts() ||
          (deadline !== undefined && clock.getTime() >= deadline.getTime());
        if (exhausted) {
          const code = reference === null ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_NOT_PROCESSED';
          applied.transaction.reject(code, clock, wallet?.balance);
          await persistResolution(tx, applied, versionBefore, [
            WagerTransactionRejected.create({
              eventId: uuidV7(),
              aggregateId: transaction.walletId,
              correlationId: uuidV7(),
              causationId: transaction.id,
              occurredAt: clock,
              data: {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                playerId: transaction.playerId,
                providerId: transaction.providerId,
                kind: transaction.kind,
                failureCode: code,
                money: transaction.money.toJSON(),
                observedBalance: wallet?.balance.toJSON(),
              },
            }),
          ]);
          return 'rejected';
        }
        const delay = backoffDelayMs(
          transaction.attemptCount + 1,
          pendingBackoffBaseMs(),
          pendingBackoffCapMs(),
        );
        const nextAttemptAt = await addMilliseconds(tx, delay);
        applied.transaction.recordUnresolvedAttempt(nextAttemptAt);
        await updateWager(tx, applied.transaction);
        return 'waiting';
      }
      await persistResolution(tx, applied, versionBefore, applied.events);
      return applied.transaction.status === 'REJECTED' ? 'rejected' : 'resolved';
    });
  }
}

async function setLocalTimeouts(em: EntityManager): Promise<void> {
  await em.execute(`select set_config('lock_timeout', '3s', true)`);
  await em.execute(`select set_config('statement_timeout', '5s', true)`);
}

function referenceTtlMs(): number {
  const raw = process.env.REFERENCE_TTL_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_REFERENCE_TTL_MS;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('REFERENCE_TTL_MS must be a positive integer');
  }
  return Number(raw);
}

async function pendingSchedule(
  em: EntityManager,
): Promise<{ nextAttemptAt: Date; deadlineAt: Date }> {
  const rows = await em.execute<
    Array<{ next_attempt_at: Date | string; deadline_at: Date | string }>
  >(
    `select now() as next_attempt_at,
            now() + (interval '1 millisecond' * ?) as deadline_at`,
    [referenceTtlMs()],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL did not return a clock');
  }
  return {
    nextAttemptAt: asDate(row.next_attempt_at),
    deadlineAt: asDate(row.deadline_at),
  };
}

function asDate(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('PostgreSQL clock did not return a timestamp');
  }
  return parsed;
}

async function lockWallet(em: EntityManager, id: string): Promise<Wallet | null> {
  const record = await em.findOne(
    WalletRecord,
    { id },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  );
  return record === null ? null : walletFrom(record);
}

async function readIdempotency(
  em: EntityManager,
  command: SubmitWagerCommand,
): Promise<
  | { kind: 'proceed' }
  | { kind: 'replay'; transaction: WagerTransaction }
  | { kind: 'conflict'; result: Extract<SubmitWagerPersistenceResult, { outcome: 'conflict' }> }
> {
  const byKey = await findByKey(em, command.idempotencyKey);
  const byPair = await findByPair(em, command.providerId, command.externalTransactionId);
  const decision = resolveIdempotency({
    existingByKey: byKey,
    existingByPair: byPair,
    incomingKey: command.idempotencyKey,
    incomingHash: hashOf(command),
  });
  if (decision.decision === 'proceed') {
    return { kind: 'proceed' };
  }
  if (decision.decision === 'replay') {
    return { kind: 'replay', transaction: decision.transaction };
  }
  return { kind: 'conflict', result: { outcome: 'conflict', failureCode: decision.failureCode } };
}

function hashOf(command: SubmitWagerCommand): string {
  const transaction = WagerTransaction.create(commandToCreate(command));
  return transaction.payloadHash;
}

function commandToCreate(command: SubmitWagerCommand) {
  return {
    id: command.id,
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    idempotencyKey: command.idempotencyKey,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: Money.from({ amount: command.amount, currency: command.currency }),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
    createdAt: command.now,
  };
}

async function findByKey(em: EntityManager, idempotencyKey: string): Promise<WagerTransaction | null> {
  const record = await em.findOne(WagerTransactionRecord, { idempotencyKey });
  return record === null ? null : wagerFrom(record);
}

async function findByPair(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTransaction | null> {
  const record = await em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
  return record === null ? null : wagerFrom(record);
}

async function findProcessedReversal(
  em: EntityManager,
  referenceTransactionId: string,
): Promise<WagerTransaction | null> {
  const record = await em.findOne(WagerTransactionRecord, {
    referenceTransactionId,
    status: 'PROCESSED',
    kind: { $in: ['REFUND', 'ROLLBACK'] },
  });
  return record === null ? null : wagerFrom(record);
}

async function insertWallet(em: EntityManager, wallet: Wallet): Promise<void> {
  const state = wallet.toState();
  await em.insert(WalletRecord, {
    id: state.id,
    playerId: state.playerId,
    currency: state.currency,
    balanceAmount: state.balance.amount,
    balanceCurrency: state.balance.currency,
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}

async function updateWallet(em: EntityManager, wallet: Wallet, previousVersion: number): Promise<void> {
  const state = wallet.toState();
  const affected = await em.nativeUpdate(
    WalletRecord,
    { id: state.id, version: previousVersion },
    {
      balanceAmount: state.balance.amount,
      balanceCurrency: state.balance.currency,
      version: state.version,
      updatedAt: state.updatedAt,
    },
  );
  if (affected !== 1) {
    throw new Error('wallet version conflict');
  }
}

async function insertWager(em: EntityManager, transaction: WagerTransaction): Promise<void> {
  const state = transaction.toState();
  await em.insert(WagerTransactionRecord, {
    id: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    walletId: state.walletId,
    playerId: state.playerId,
    roundId: state.roundId,
    gameId: state.gameId,
    kind: state.kind,
    amount: state.money.amount,
    currency: state.money.currency,
    referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
    referenceTransactionId: state.referenceTransactionId ?? null,
    status: state.status,
    failureCode: state.failureCode ?? null,
    processedAt: state.processedAt ?? null,
    observedBalanceAmount: state.observedBalance?.amount ?? null,
    observedBalanceCurrency: state.observedBalance?.currency ?? null,
    attemptCount: state.attemptCount,
    nextAttemptAt: state.nextAttemptAt ?? null,
    deadlineAt: state.deadlineAt ?? null,
    createdAt: state.createdAt,
  });
}

async function insertLedger(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
  const state = entry.toState();
  await em.insert(WalletLedgerEntryRecord, {
    id: state.id,
    walletId: state.walletId,
    transactionId: state.transactionId,
    direction: state.direction,
    amount: state.amount.amount,
    currency: state.amount.currency,
    balanceBefore: state.balanceBefore.amount,
    balanceBeforeCurrency: state.balanceBefore.currency,
    balanceAfter: state.balanceAfter.amount,
    balanceAfterCurrency: state.balanceAfter.currency,
    createdAt: state.createdAt,
  });
}

async function insertEvents(em: EntityManager, events: readonly IntegrationEvent<unknown>[]): Promise<void> {
  for (const event of events) {
    await em.insert(OutboxMessageRecord, {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
  }
}

type InboxDisposition = 'absent' | 'recorded' | 'duplicate' | 'pending' | 'mismatch';

async function ensureInbox(em: EntityManager, command: SubmitWagerCommand): Promise<InboxDisposition> {
  if (command.inbox === undefined) {
    return 'absent';
  }
  const existing = await em.findOne(InboxMessageRecord, {
    consumerName: CONSUMER_NAME,
    messageId: command.inbox.messageId,
  });
  if (existing !== null) {
    if (existing.payloadHash !== command.inbox.payloadHash) {
      await em.insert(IngressRejectRecord, {
        id: uuidV7(),
        consumerName: CONSUMER_NAME,
        messageId: command.inbox.messageId,
        payloadHash: command.inbox.payloadHash,
        failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        receivedAt: command.now,
      });
      return 'mismatch';
    }
    if (existing.processedAt === null) {
      return 'pending';
    }
    return 'duplicate';
  }
  await em.insert(InboxMessageRecord, {
    consumerName: CONSUMER_NAME,
    messageId: command.inbox.messageId,
    payloadHash: command.inbox.payloadHash,
    receivedAt: command.now,
    processedAt: command.now,
  });
  return 'recorded';
}

function absorbInbox(
  status: InboxDisposition,
  replay: { transaction: WagerTransaction; wallet: Wallet | null } | null,
): SubmitWagerPersistenceResult | null {
  if (status === 'mismatch') {
    return { outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH', inbox: 'mismatch' };
  }
  if (status === 'pending') {
    return { outcome: 'inbox-held' };
  }
  if (status === 'duplicate') {
    if (replay === null) {
      return { outcome: 'duplicate' };
    }
    return {
      outcome: 'replay',
      transaction: replay.transaction,
      wallet: replay.wallet,
      entry: null,
      inbox: 'duplicate',
    };
  }
  return null;
}

async function postgresNow(em: EntityManager): Promise<Date> {
  const rows = await em.execute<Array<{ now: Date | string }>>(`select now() as now`);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL did not return a clock');
  }
  return asDate(row.now);
}

async function addMilliseconds(em: EntityManager, delayMs: number): Promise<Date> {
  const rows = await em.execute<Array<{ next_attempt_at: Date | string }>>(
    `select now() + (interval '1 millisecond' * ?) as next_attempt_at`,
    [delayMs],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL did not return a clock');
  }
  return asDate(row.next_attempt_at);
}

async function persistResolution(
  em: EntityManager,
  applied: { transaction: WagerTransaction; wallet: Wallet | null; entry: WalletLedgerEntry | null },
  versionBefore: number | undefined,
  events: readonly IntegrationEvent<unknown>[],
): Promise<void> {
  if (applied.entry !== null) {
    await insertLedger(em, applied.entry);
  }
  if (applied.wallet !== null && versionBefore !== undefined && applied.wallet.version !== versionBefore) {
    await updateWallet(em, applied.wallet, versionBefore);
  }
  await updateWager(em, applied.transaction);
  await insertEvents(em, events);
}

async function updateWager(em: EntityManager, transaction: WagerTransaction): Promise<void> {
  const state = transaction.toState();
  const affected = await em.nativeUpdate(
    WagerTransactionRecord,
    { id: state.id },
    {
      referenceTransactionId: state.referenceTransactionId ?? null,
      status: state.status,
      failureCode: state.failureCode ?? null,
      processedAt: state.processedAt ?? null,
      observedBalanceAmount: state.observedBalance?.amount ?? null,
      observedBalanceCurrency: state.observedBalance?.currency ?? null,
      attemptCount: state.attemptCount,
      nextAttemptAt: state.nextAttemptAt ?? null,
      deadlineAt: state.deadlineAt ?? null,
    },
  );
  if (affected !== 1) {
    throw new Error('Pending wager was not updated');
  }
}

function walletFrom(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: { amount: record.balanceAmount, currency: record.balanceCurrency },
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function wagerFrom(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: { amount: record.amount, currency: record.currency },
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransaction['status'],
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    observedBalance:
      record.observedBalanceAmount === null || record.observedBalanceCurrency === null
        ? undefined
        : { amount: record.observedBalanceAmount, currency: record.observedBalanceCurrency },
    attemptCount: record.attemptCount,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    deadlineAt: record.deadlineAt ?? undefined,
  });
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_before_currency: string;
  balance_after: string;
  balance_after_currency: string;
  created_at: Date | string;
}

function ledgerFromRow(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as 'DEBIT' | 'CREDIT',
    amount: { amount: row.amount, currency: row.currency },
    balanceBefore: { amount: row.balance_before, currency: row.balance_before_currency },
    balanceAfter: { amount: row.balance_after, currency: row.balance_after_currency },
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  });
}

function ledgerFrom(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as 'DEBIT' | 'CREDIT',
    amount: { amount: record.amount, currency: record.currency },
    balanceBefore: { amount: record.balanceBefore, currency: record.balanceBeforeCurrency },
    balanceAfter: { amount: record.balanceAfter, currency: record.balanceAfterCurrency },
    createdAt: record.createdAt,
  });
}
