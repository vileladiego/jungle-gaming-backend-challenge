import { describe, expect, test } from 'bun:test';
import { classifyPostgresError, persistsAsFailed } from '../src/persistence/postgres-error';

describe('classificação de erro do Postgres', () => {
  test('timeout, deadlock e serialização são transitórios', () => {
    for (const code of ['40P01', '55P03', '57014', '40001']) {
      expect(classifyPostgresError({ code })).toEqual({ kind: 'transient', code });
    }
  });

  test('estouro numérico não é corrupção', () => {
    expect(classifyPostgresError({ code: '22003' })).toEqual({ kind: 'overflow' });
  });

  test('unicidade conhecida permanece unicidade', () => {
    expect(
      classifyPostgresError({ code: '23505', constraint: 'ux_reversal_once' }),
    ).toEqual({ kind: 'unique', name: 'ux_reversal_once' });
    expect(
      classifyPostgresError({ code: '23505', constraint: 'uq_wager_transactions_idempotency_key' }),
    ).toEqual({ kind: 'unique', name: 'uq_wager_transactions_idempotency_key' });
  });

  test('check de saldo é rejeição de negócio', () => {
    expect(
      classifyPostgresError({ code: '23514', constraint: 'ck_wallets_balance_nonnegative' }),
    ).toEqual({ kind: 'balance-check', name: 'ck_wallets_balance_nonnegative' });
  });

  test('trigger de imutabilidade é erro de programação', () => {
    expect(
      classifyPostgresError({ code: '23514', constraint: 'wallet_ledger_entries_append_only' }),
    ).toEqual({ kind: 'programming', name: 'wallet_ledger_entries_append_only' });
  });

  test('constraint sem nome conhecido não vira timeout', () => {
    expect(classifyPostgresError({ code: '23514', constraint: 'ck_phase3_probe' })).toEqual({
      kind: 'unknown-constraint',
      name: 'ck_phase3_probe',
      code: '23514',
    });
    expect(classifyPostgresError({ code: '23505', constraint: 'wager_transactions_pkey' })).toEqual({
      kind: 'unknown-constraint',
      name: 'wager_transactions_pkey',
      code: '23505',
    });
    expect(classifyPostgresError({ code: '23505' })).toEqual({
      kind: 'unknown-constraint',
      name: '',
      code: '23505',
    });
  });

  test('só constraint desconhecida persiste FAILED', () => {
    expect(persistsAsFailed(classifyPostgresError({ code: '40P01' }))).toBe(false);
    expect(persistsAsFailed(classifyPostgresError({ code: '55P03' }))).toBe(false);
    expect(persistsAsFailed(classifyPostgresError({ code: '57014' }))).toBe(false);
    expect(persistsAsFailed(classifyPostgresError({ code: '40001' }))).toBe(false);
    expect(persistsAsFailed(classifyPostgresError({ code: '22003' }))).toBe(false);
    expect(
      persistsAsFailed(classifyPostgresError({ code: '23505', constraint: 'uq_wager_transactions_idempotency_key' })),
    ).toBe(false);
    expect(
      persistsAsFailed(classifyPostgresError({ code: '23505', constraint: 'ux_reversal_once' })),
    ).toBe(false);
    expect(
      persistsAsFailed(classifyPostgresError({ code: '23514', constraint: 'ck_wallets_balance_nonnegative' })),
    ).toBe(false);
    expect(
      persistsAsFailed(classifyPostgresError({ code: '23514', constraint: 'wallet_ledger_entries_append_only' })),
    ).toBe(false);
    expect(persistsAsFailed(classifyPostgresError({ code: '23514', constraint: 'ck_phase3_probe' }))).toBe(true);
    expect(persistsAsFailed(classifyPostgresError({ code: '23505' }))).toBe(true);
  });

  test('lê code e constraint dentro de cause', () => {
    expect(
      classifyPostgresError({ cause: { code: '23505', constraint: 'uq_wallets_player_currency' } }),
    ).toEqual({ kind: 'unique', name: 'uq_wallets_player_currency' });
  });
});
