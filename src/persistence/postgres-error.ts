export type PostgresFailure =
  | { kind: 'transient'; code: string }
  | { kind: 'overflow' }
  | { kind: 'unique'; name: string }
  | { kind: 'balance-check'; name: string }
  | { kind: 'programming'; name: string }
  | { kind: 'unknown-constraint'; name: string; code: string }
  | { kind: 'other' };

const TRANSIENT = new Set(['40P01', '55P03', '57014', '40001', '08000', '08003', '08006', '57P01']);

const BALANCE_CHECKS = new Set([
  'ck_wallets_balance_nonnegative',
  'ck_wallet_ledger_entries_balance_before',
  'ck_wallet_ledger_entries_balance_after',
  'ck_wallet_ledger_entries_arithmetic',
]);

const PROGRAMMING = new Set([
  'wallet_ledger_entries_append_only',
  'wager_transactions_immutable',
]);

const KNOWN_UNIQUES = new Set([
  'uq_wallets_player_currency',
  'uq_wager_transactions_idempotency_key',
  'uq_wager_transactions_provider_external',
  'uq_wallet_ledger_entries_transaction',
  'ux_reversal_once',
  'inbox_messages_pkey',
]);

export function classifyPostgresError(error: unknown): PostgresFailure {
  const details = readPostgresError(error);
  if (details.code === undefined) {
    return { kind: 'other' };
  }
  if (TRANSIENT.has(details.code)) {
    return { kind: 'transient', code: details.code };
  }
  if (details.code === '22003') {
    return { kind: 'overflow' };
  }
  const name = details.constraint;
  if ((details.code === '23505' || details.code === '23514') && name !== undefined) {
    if (PROGRAMMING.has(name)) {
      return { kind: 'programming', name };
    }
    if (BALANCE_CHECKS.has(name)) {
      return { kind: 'balance-check', name };
    }
    if (details.code === '23505' && KNOWN_UNIQUES.has(name)) {
      return { kind: 'unique', name };
    }
    return { kind: 'unknown-constraint', name, code: details.code };
  }
  if ((details.code === '23505' || details.code === '23514') && name === undefined) {
    return { kind: 'unknown-constraint', name: '', code: details.code };
  }
  return { kind: 'other' };
}

/** D14: só constraint que o código não sabe nomear vira FAILED. */
export function persistsAsFailed(failure: PostgresFailure): boolean {
  return failure.kind === 'unknown-constraint';
}

function readPostgresError(error: unknown): { code?: string; constraint?: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        constraint: typeof record.constraint === 'string' ? record.constraint : undefined,
      };
    }
    current = record.cause;
  }
  return {};
}
