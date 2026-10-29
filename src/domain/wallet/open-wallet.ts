import { DomainError } from '../domain-error';
import { IntegrationEvent } from '../events/integration-event';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../events/wager-events';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { WagerTransaction } from '../wager/wager-transaction';
import { Wallet } from './wallet';

export interface OpenWalletResult {
  wallet: Wallet;
  transaction: WagerTransaction | null;
  entry: WalletLedgerEntry | null;
  events: IntegrationEvent<unknown>[];
}

/**
 * Saldo zero: version 1, sem OPENING e sem ledger.
 * Saldo positivo: o saldo já nasce no valor inicial e a version permanece 1.
 * O CREDIT não passa por wallet.credit, que incrementaria a version.
 */
export function openWallet(props: {
  id: string;
  playerId: string;
  initialBalance: Money;
  transactionId: string;
  entryId: string;
  now: Date;
  correlationId: string;
  nextEventId: () => string;
}): OpenWalletResult {
  if (props.initialBalance.isNegative()) {
    throw new DomainError('INVALID_PAYLOAD', 'Opening balance cannot be negative');
  }
  const wallet = Wallet.open({
    id: props.id,
    playerId: props.playerId,
    initialBalance: props.initialBalance,
    now: props.now,
  });
  if (props.initialBalance.isZero()) {
    return { wallet, transaction: null, entry: null, events: [] };
  }
  const transaction = WagerTransaction.createOpening({
    id: props.transactionId,
    providerId: 'internal',
    externalTransactionId: props.id,
    idempotencyKey: `internal:${props.id}`,
    walletId: props.id,
    playerId: props.playerId,
    roundId: 'internal',
    gameId: 'internal',
    kind: 'OPENING',
    money: props.initialBalance,
    observedBalance: props.initialBalance,
    createdAt: props.now,
  });
  const entry = WalletLedgerEntry.create({
    id: props.entryId,
    walletId: wallet.id,
    transactionId: transaction.id,
    direction: 'CREDIT',
    amount: props.initialBalance.toJSON(),
    balanceBefore: Money.zero(props.initialBalance.currency).toJSON(),
    balanceAfter: props.initialBalance.toJSON(),
    createdAt: props.now,
  });
  return {
    wallet,
    transaction,
    entry,
    events: [
      WagerTransactionProcessed.create({
        eventId: props.nextEventId(),
        aggregateId: wallet.id,
        correlationId: props.correlationId,
        causationId: transaction.id,
        occurredAt: props.now,
        data: {
          transactionId: transaction.id,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: transaction.providerId,
          kind: 'OPENING',
          money: props.initialBalance.toJSON(),
          observedBalance: props.initialBalance.toJSON(),
        },
      }),
      WalletBalanceChanged.from(wallet, entry, {
        eventId: props.nextEventId(),
        correlationId: props.correlationId,
        causationId: transaction.id,
        occurredAt: props.now,
      }),
    ],
  };
}
