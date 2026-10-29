import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { NumericStringType } from './numeric-string.type';

@Entity({ tableName: 'wallets' })
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id' })
  playerId!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ type: NumericStringType, fieldName: 'balance_amount' })
  balanceAmount!: string;

  @Property({ fieldName: 'balance_currency', length: 3 })
  balanceCurrency!: string;

  @Property()
  version!: number;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at' })
  updatedAt!: Date;
}

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id' })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ fieldName: 'player_id' })
  playerId!: string;

  @Property({ fieldName: 'round_id' })
  roundId!: string;

  @Property({ fieldName: 'game_id' })
  gameId!: string;

  @Property()
  kind!: string;

  @Property({ type: NumericStringType })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ fieldName: 'reference_external_transaction_id', nullable: true })
  referenceExternalTransactionId: string | null = null;

  @Property({ type: 'uuid', fieldName: 'reference_transaction_id', nullable: true })
  referenceTransactionId: string | null = null;

  @Property()
  status!: string;

  @Property({ fieldName: 'failure_code', nullable: true })
  failureCode: string | null = null;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt: Date | null = null;

  @Property({ type: NumericStringType, fieldName: 'observed_balance_amount', nullable: true })
  observedBalanceAmount: string | null = null;

  @Property({ fieldName: 'observed_balance_currency', nullable: true, length: 3 })
  observedBalanceCurrency: string | null = null;

  @Property({ fieldName: 'attempt_count' })
  attemptCount!: number;

  @Property({ fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt: Date | null = null;

  @Property({ fieldName: 'deadline_at', nullable: true })
  deadlineAt: Date | null = null;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;
}

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property()
  direction!: string;

  @Property({ type: NumericStringType })
  amount!: string;

  @Property({ length: 3 })
  currency!: string;

  @Property({ type: NumericStringType, fieldName: 'balance_before' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_before_currency', length: 3 })
  balanceBeforeCurrency!: string;

  @Property({ type: NumericStringType, fieldName: 'balance_after' })
  balanceAfter!: string;

  @Property({ fieldName: 'balance_after_currency', length: 3 })
  balanceAfterCurrency!: string;

  @Property({ fieldName: 'created_at' })
  createdAt!: Date;
}

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageRecord {
  @PrimaryKey({ fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id' })
  messageId!: string;

  @Property({ fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', nullable: true })
  processedAt: Date | null = null;
}

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property()
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', nullable: true })
  nextAttemptAt: Date | null = null;

  @Property({ fieldName: 'published_at', nullable: true })
  publishedAt: Date | null = null;
}

@Entity({ tableName: 'ingress_rejects' })
export class IngressRejectRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'consumer_name' })
  consumerName!: string;

  @Property({ fieldName: 'message_id' })
  messageId!: string;

  @Property({ fieldName: 'payload_hash', nullable: true })
  payloadHash: string | null = null;

  @Property({ fieldName: 'failure_code' })
  failureCode!: string;

  @Property({ fieldName: 'received_at' })
  receivedAt!: Date;
}
