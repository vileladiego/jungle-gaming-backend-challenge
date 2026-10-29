import { Migration } from '@mikro-orm/migrations';

const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
  'ingress_rejects',
] as const;

/**
 * Schema financeiro. down remove triggers, funções e tabelas.
 * Não há UPDATE de dados. O papel wager_app não é dono.
 */
export class Migration20261029160100_Financial extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency varchar(3) not null,
        balance_amount numeric(20,2) not null,
        balance_currency varchar(3) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint uq_wallets_player_currency unique (player_id, currency),
        constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wallets_balance_currency check (balance_currency ~ '^[A-Z]{3}$'),
        constraint ck_wallets_currency_match check (balance_currency = currency),
        constraint ck_wallets_balance_nonnegative check (balance_amount >= 0),
        constraint ck_wallets_version check (version >= 1)
      )
    `);
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20,2) not null,
        currency varchar(3) not null,
        reference_external_transaction_id text null,
        reference_transaction_id uuid null,
        status text not null,
        failure_code text null,
        processed_at timestamptz null,
        observed_balance_amount numeric(20,2) null,
        observed_balance_currency varchar(3) null,
        attempt_count integer not null default 0,
        next_attempt_at timestamptz null,
        deadline_at timestamptz null,
        created_at timestamptz not null,
        constraint uq_wager_transactions_idempotency_key unique (idempotency_key),
        constraint uq_wager_transactions_provider_external unique (provider_id, external_transaction_id),
        constraint ck_wager_transactions_kind check (
          kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint ck_wager_transactions_status check (
          status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        constraint ck_wager_transactions_amount_positive check (amount > 0),
        constraint ck_wager_transactions_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wager_transactions_reference_required check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint ck_wager_transactions_bet_loss_no_reference check (
          kind not in ('BET', 'LOSS') or reference_external_transaction_id is null
        ),
        constraint ck_wager_transactions_processed_reversal_reference check (
          status <> 'PROCESSED'
          or kind not in ('REFUND', 'ROLLBACK')
          or reference_transaction_id is not null
        ),
        constraint ck_wager_transactions_observed_pair check (
          (
            observed_balance_amount is null
            and observed_balance_currency is null
          )
          or (
            observed_balance_amount is not null
            and observed_balance_currency is not null
            and observed_balance_currency ~ '^[A-Z]{3}$'
          )
        ),
        constraint ck_wager_transactions_pending_schedule check (
          status <> 'PENDING_REFERENCE'
          or (next_attempt_at is not null and deadline_at is not null)
        ),
        constraint ck_wager_transactions_attempt_count check (attempt_count >= 0),
        constraint ck_wager_transactions_failure_code check (
          (
            status = 'REJECTED'
            and failure_code is not null
          )
          or (
            status = 'FAILED'
            and failure_code = 'PERSISTENT_STATE_CORRUPT'
          )
          or (
            status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
            and failure_code is null
          )
        )
      )
    `);
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(20,2) not null,
        currency varchar(3) not null,
        balance_before numeric(20,2) not null,
        balance_before_currency varchar(3) not null,
        balance_after numeric(20,2) not null,
        balance_after_currency varchar(3) not null,
        created_at timestamptz not null,
        constraint uq_wallet_ledger_entries_transaction unique (transaction_id),
        constraint ck_wallet_ledger_entries_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint ck_wallet_ledger_entries_amount_positive check (amount > 0),
        constraint ck_wallet_ledger_entries_currency check (
          currency ~ '^[A-Z]{3}$'
          and balance_before_currency ~ '^[A-Z]{3}$'
          and balance_after_currency ~ '^[A-Z]{3}$'
          and currency = balance_before_currency
          and currency = balance_after_currency
        ),
        constraint ck_wallet_ledger_entries_balance_before check (balance_before >= 0),
        constraint ck_wallet_ledger_entries_balance_after check (balance_after >= 0),
        constraint ck_wallet_ledger_entries_arithmetic check (
          (
            direction = 'CREDIT'
            and balance_after = balance_before + amount
          )
          or (
            direction = 'DEBIT'
            and balance_after = balance_before - amount
          )
        )
      )
    `);
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )
    `);
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz null,
        published_at timestamptz null,
        constraint ck_outbox_messages_attempts check (attempts >= 0)
      )
    `);
    this.addSql(`
      create table ingress_rejects (
        id uuid primary key,
        consumer_name text not null,
        message_id text not null,
        payload_hash text null,
        failure_code text not null,
        received_at timestamptz not null
      )
    `);
    this.addSql(`
      create unique index ux_reversal_once
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED'
          and kind in ('REFUND', 'ROLLBACK')
    `);
    this.addSql(`
      create index ix_wager_transactions_pending
        on wager_transactions (next_attempt_at, id)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      create index ix_outbox_messages_pending
        on outbox_messages (occurred_at, id)
        where published_at is null
    `);
    this.addSql(`
      create function wallet_ledger_entries_append_only_fn() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet ledger is append-only'
          using errcode = '23514', constraint = 'wallet_ledger_entries_append_only';
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
      before update or delete on wallet_ledger_entries
      for each row execute function wallet_ledger_entries_append_only_fn()
    `);
    this.addSql(`
      create function wager_transactions_guard_fn() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transaction cannot be deleted'
            using errcode = '23514', constraint = 'wager_transactions_immutable';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction is terminal'
            using errcode = '23514', constraint = 'wager_transactions_immutable';
        end if;
        if new.id is distinct from old.id
          or new.provider_id is distinct from old.provider_id
          or new.external_transaction_id is distinct from old.external_transaction_id
          or new.idempotency_key is distinct from old.idempotency_key
          or new.payload_hash is distinct from old.payload_hash
          or new.wallet_id is distinct from old.wallet_id
          or new.player_id is distinct from old.player_id
          or new.round_id is distinct from old.round_id
          or new.game_id is distinct from old.game_id
          or new.kind is distinct from old.kind
          or new.amount is distinct from old.amount
          or new.currency is distinct from old.currency
          or new.reference_external_transaction_id is distinct from old.reference_external_transaction_id
          or new.created_at is distinct from old.created_at
        then
          raise exception 'wager transaction financial columns are immutable'
            using errcode = '23514', constraint = 'wager_transactions_immutable';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard
      before update or delete on wager_transactions
      for each row execute function wager_transactions_guard_fn()
    `);
    this.addSql(
      `grant select, insert, update, delete on ${TABLES.join(', ')} to wager_app`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists wager_transactions_guard on wager_transactions`);
    this.addSql(`drop trigger if exists wallet_ledger_entries_append_only on wallet_ledger_entries`);
    this.addSql(`drop function if exists wager_transactions_guard_fn()`);
    this.addSql(`drop function if exists wallet_ledger_entries_append_only_fn()`);
    this.addSql(`drop index if exists ux_reversal_once`);
    this.addSql(`drop index if exists ix_wager_transactions_pending`);
    this.addSql(`drop index if exists ix_outbox_messages_pending`);
    this.addSql(`drop table if exists ingress_rejects`);
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
  }
}
