import { LockMode } from '@mikro-orm/core';
import { type EntityManager, type MikroORM } from '@mikro-orm/postgresql';
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
import { classifyPostgresError } from './postgres-error';
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
const REFERENCE_TTL_MS = 15 * 60 * 1000;

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
    }
  | {
      outcome: 'conflict';
      failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'IDEMPOTENCY_KEY_MISMATCH';
    };

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
      if ((await ensureInbox(tx, command)) === 'mismatch') {
        return { outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
      }
      return { outcome: 'replay', transaction: decision.transaction, wallet, entry: null };
    }
    if (decision.kind === 'conflict') {
      return decision.result;
    }
    if ((await ensureInbox(tx, command)) === 'mismatch') {
      return { outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
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
      deadlineAt: new Date(command.now.getTime() + REFERENCE_TTL_MS),
      entryId: uuidV7(),
      correlationId: command.correlationId,
      nextEventId: () => uuidV7(),
    });
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
    if (classified.kind === 'unknown-constraint') {
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
        if ((await ensureInbox(tx, command)) === 'mismatch') {
          return { outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
        }
        return { outcome: 'replay' as const, transaction: decision.transaction, wallet, entry: null };
      }
      if (decision.kind === 'conflict') {
        return decision.result;
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
          if ((await ensureInbox(tx, command)) === 'mismatch') {
            return { outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
          }
          return { outcome: 'replay' as const, transaction: decision.transaction, wallet, entry: null };
        }
        if (decision.kind === 'conflict') {
          return decision.result;
        }
        if ((await ensureInbox(tx, command)) === 'mismatch') {
          return { outcome: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
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
        return { outcome: 'rejected' as const, transaction, wallet, entry: null };
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
          return { outcome: 'replay' as const, transaction: decision.transaction, wallet, entry: null };
        }
        if (decision.kind === 'conflict') {
          return decision.result;
        }
        const transaction = WagerTransaction.create(commandToCreate(command));
        transaction.fail('PERSISTENT_STATE_CORRUPT', command.now);
        await insertWager(tx, transaction);
        return { outcome: 'failed' as const, transaction, wallet, entry: null };
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
}

async function setLocalTimeouts(em: EntityManager): Promise<void> {
  await em.execute(`select set_config('lock_timeout', '3s', true)`);
  await em.execute(`select set_config('statement_timeout', '5s', true)`);
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

async function ensureInbox(em: EntityManager, command: SubmitWagerCommand): Promise<'ok' | 'mismatch'> {
  if (command.inbox === undefined) {
    return 'ok';
  }
  const existing = await em.findOne(InboxMessageRecord, {
    consumerName: CONSUMER_NAME,
    messageId: command.inbox.messageId,
  });
  if (existing !== null) {
    if (existing.payloadHash === command.inbox.payloadHash) {
      return 'ok';
    }
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
  await em.insert(InboxMessageRecord, {
    consumerName: CONSUMER_NAME,
    messageId: command.inbox.messageId,
    payloadHash: command.inbox.payloadHash,
    receivedAt: command.now,
    processedAt: command.now,
  });
  return 'ok';
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
