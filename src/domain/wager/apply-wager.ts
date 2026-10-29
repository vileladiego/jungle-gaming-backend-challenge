import { DomainError, InvalidTransactionStateError } from '../domain-error';
import type { FailureCode } from '../failure-code';
import { IntegrationEvent } from '../events/integration-event';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../events/wager-events';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { Wallet } from '../wallet/wallet';
import { WagerTransaction } from './wager-transaction';

export interface ApplyWagerInput {
  transaction: WagerTransaction;
  wallet: Wallet | null;
  reference: WagerTransaction | null;
  processedReversal: WagerTransaction | null;
  now: Date;
  deadlineAt: Date;
  entryId: string;
  correlationId: string;
  nextEventId: () => string;
}

export interface ApplyWagerResult {
  transaction: WagerTransaction;
  wallet: Wallet | null;
  entry: WalletLedgerEntry | null;
  events: IntegrationEvent<unknown>[];
}

export function applyWager(input: ApplyWagerInput): ApplyWagerResult {
  const { transaction, wallet } = input;
  if (transaction.status !== 'PENDING' && transaction.status !== 'PENDING_REFERENCE') {
    throw new InvalidTransactionStateError(`Transaction is already ${transaction.status}`);
  }
  if (wallet === null || wallet.id !== transaction.walletId) {
    return reject(input, 'WALLET_NOT_FOUND', undefined);
  }
  if (wallet.playerId !== transaction.playerId) {
    return reject(input, 'WALLET_PLAYER_MISMATCH', wallet.balance);
  }
  if (wallet.currency !== transaction.money.currency) {
    return reject(input, 'CURRENCY_MISMATCH', wallet.balance);
  }

  const referenceGate = gateReference(input, wallet.balance);
  if (referenceGate !== 'ready') {
    return referenceGate;
  }

  if (transaction.kind === 'LOSS') {
    transaction.markProcessed(undefined, input.now, wallet.balance);
    return {
      transaction,
      wallet,
      entry: null,
      events: [processedEvent(input, wallet.balance)],
    };
  }

  const reference = input.reference ?? undefined;
  const direction = transaction.ledgerDirectionFor(reference);
  const versionBefore = wallet.version;
  const balanceBefore = wallet.balance.toJSON();
  let entry: WalletLedgerEntry;
  try {
    const movement = {
      entryId: input.entryId,
      transactionId: transaction.id,
      amount: transaction.money,
      at: input.now,
    };
    entry = direction === 'DEBIT' ? wallet.debit(movement) : wallet.credit(movement);
  } catch (error) {
    if (error instanceof DomainError && error.failureCode === 'AMOUNT_OVERFLOW') {
      return reject(input, 'AMOUNT_OVERFLOW', Money.from(balanceBefore));
    }
    if (error instanceof DomainError && error.failureCode === 'INSUFFICIENT_FUNDS') {
      const code =
        direction === 'DEBIT' && transaction.kind === 'ROLLBACK'
          ? 'REVERSAL_INSUFFICIENT_FUNDS'
          : 'INSUFFICIENT_FUNDS';
      return reject(input, code, Money.from(balanceBefore));
    }
    throw error;
  }
  if (wallet.version !== versionBefore + 1) {
    throw new Error('Balance movement did not advance the wallet version');
  }
  transaction.markProcessed(
    reference === undefined ? undefined : reference.id,
    input.now,
    wallet.balance,
  );
  return {
    transaction,
    wallet,
    entry,
    events: [
      processedEvent(input, wallet.balance),
      WalletBalanceChanged.from(wallet, entry, {
        eventId: input.nextEventId(),
        correlationId: input.correlationId,
        causationId: transaction.id,
        occurredAt: input.now,
      }),
    ],
  };
}

function gateReference(input: ApplyWagerInput, observed: Money): 'ready' | ApplyWagerResult {
  const { transaction, reference } = input;
  const externalId = transaction.referenceExternalTransactionId;
  if (externalId === undefined) {
    return 'ready';
  }
  if (reference === null) {
    return wait(input, observed);
  }
  if (reference.externalTransactionId !== externalId) {
    throw new InvalidTransactionStateError('Reference does not match the external id');
  }
  if (reference.status === 'REJECTED' || reference.status === 'FAILED') {
    return reject(input, 'REFERENCE_NOT_PROCESSED', observed);
  }
  if (reference.status !== 'PROCESSED') {
    return wait(input, observed);
  }
  if (!sameScope(transaction, reference)) {
    return reject(input, 'REFERENCE_SCOPE_MISMATCH', observed);
  }
  if (!allowedKind(transaction, reference)) {
    return reject(input, 'REFERENCE_KIND_NOT_ALLOWED', observed);
  }
  if (transaction.kind !== 'WIN' && !transaction.money.equals(reference.money)) {
    return reject(input, 'AMOUNT_MISMATCH', observed);
  }
  if (
    (transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK') &&
    input.processedReversal?.occupiesReversalSlot() === true &&
    input.processedReversal.referenceTransactionId === reference.id
  ) {
    return reject(input, 'REFERENCE_ALREADY_REVERSED', observed);
  }
  return 'ready';
}

function sameScope(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    transaction.providerId === reference.providerId &&
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.money.currency === reference.money.currency &&
    transaction.roundId === reference.roundId
  );
}

function allowedKind(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  if (transaction.kind === 'WIN' || transaction.kind === 'REFUND') {
    return reference.kind === 'BET';
  }
  if (transaction.kind === 'ROLLBACK') {
    return reference.kind === 'BET' || reference.kind === 'WIN' || reference.kind === 'REFUND';
  }
  return false;
}

function wait(input: ApplyWagerInput, observed: Money): ApplyWagerResult {
  const { transaction } = input;
  const events: IntegrationEvent<unknown>[] = [];
  if (transaction.status === 'PENDING') {
    transaction.markPendingReference(input.now, input.deadlineAt, observed);
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (referenceExternalTransactionId === undefined) {
      throw new Error('Pending reference is missing its external id');
    }
    events.push(
      WagerTransactionPendingReference.create({
        eventId: input.nextEventId(),
        aggregateId: transaction.walletId,
        correlationId: input.correlationId,
        causationId: transaction.id,
        occurredAt: input.now,
        data: {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          referenceExternalTransactionId,
          money: transaction.money.toJSON(),
          observedBalance: observed.toJSON(),
        },
      }),
    );
  }
  return { transaction, wallet: input.wallet, entry: null, events };
}

function reject(input: ApplyWagerInput, code: FailureCode, observed: Money | undefined): ApplyWagerResult {
  input.transaction.reject(code, input.now, observed);
  return {
    transaction: input.transaction,
    wallet: input.wallet,
    entry: null,
    events: [
      WagerTransactionRejected.create({
        eventId: input.nextEventId(),
        aggregateId: input.transaction.walletId,
        correlationId: input.correlationId,
        causationId: input.transaction.id,
        occurredAt: input.now,
        data: {
          transactionId: input.transaction.id,
          walletId: input.transaction.walletId,
          playerId: input.transaction.playerId,
          providerId: input.transaction.providerId,
          kind: input.transaction.kind,
          failureCode: code,
          money: input.transaction.money.toJSON(),
          observedBalance: observed?.toJSON(),
        },
      }),
    ],
  };
}

function processedEvent(input: ApplyWagerInput, observed: Money): WagerTransactionProcessed {
  return WagerTransactionProcessed.create({
    eventId: input.nextEventId(),
    aggregateId: input.transaction.walletId,
    correlationId: input.correlationId,
    causationId: input.transaction.id,
    occurredAt: input.now,
    data: {
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      playerId: input.transaction.playerId,
      providerId: input.transaction.providerId,
      kind: input.transaction.kind,
      money: input.transaction.money.toJSON(),
      observedBalance: observed.toJSON(),
    },
  });
}
