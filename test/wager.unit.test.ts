import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { DomainError, InvalidTransactionStateError } from '../src/domain/domain-error';
import { DOMAIN_EVENT_TYPES } from '../src/domain/events/integration-event';
import { canonicalPayloadHash } from '../src/domain/wager/payload-hash';
import { applyWager } from '../src/domain/wager/apply-wager';
import { resolveIdempotency } from '../src/domain/wager/idempotency';
import { WagerTransaction } from '../src/domain/wager/wager-transaction';
import { apply, brl, DEADLINE, NOW, openWith, wager } from './support/wager-fixtures';

function failureCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) {
      return error.failureCode;
    }
    throw error;
  }
  throw new Error('expected a domain error');
}

describe('WagerTransaction', () => {
  test('hash canônico ignora transporte e ordena as chaves', () => {
    const body =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","roundId":"round-987","walletId":"wallet-1"}';
    const expected = createHash('sha256').update(body, 'utf8').digest('hex');
    const hash = canonicalPayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      messageId: 'msg-1',
      occurredAt: '2026-10-29T18:00:00.000Z',
      idempotencyKey: 'provider-a:transaction-123',
    });
    expect(hash).toBe(expected);
    expect(failureCode(() => canonicalPayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: '',
    }))).toBe('INVALID_PAYLOAD');
  });

  test('create recusa contrato inválido e zero externo', () => {
    expect(failureCode(() => wager({ kind: 'OPENING' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ amount: '0.00' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ amount: '0' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ providerId: 'internal' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ providerId: 'bad id' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ kind: 'BET', reference: 'bet-ext' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ kind: 'LOSS', reference: 'bet-ext' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ kind: 'REFUND', reference: null }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ kind: 'ROLLBACK', reference: '' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => wager({ kind: 'REFUND' }))).toBe('REFERENCE_REQUIRED');
    expect(failureCode(() => wager({ kind: 'ROLLBACK' }))).toBe('REFERENCE_REQUIRED');
    expect(
      failureCode(() =>
        WagerTransaction.create({
          ...wager({ id: 'bet-key' }).toState(),
          idempotencyKey: 'other-key',
          money: brl('25.00'),
          createdAt: NOW,
          kind: 'BET',
        }),
      ),
    ).toBe('INVALID_PAYLOAD');
  });

  test('BET debita, WIN credita e LOSS não move saldo nem version', () => {
    const opened = openWith('100.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet-1', externalId: 'bet-ext', amount: '25.00' }) });
    expect(bet.transaction.status).toBe('PROCESSED');
    expect(bet.entry?.direction).toBe('DEBIT');
    expect(bet.entry?.isBalanced()).toBe(true);
    expect(opened.wallet.balance.toJSON().amount).toBe('75.00');
    expect(opened.wallet.version).toBe(2);
    expect(bet.events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(bet.events[0]?.version).toBe(1);

    const win = apply({
      opened,
      transaction: wager({ id: 'win-1', externalId: 'win-ext', kind: 'WIN', amount: '10.00' }),
    });
    expect(win.entry?.direction).toBe('CREDIT');
    expect(opened.wallet.balance.toJSON().amount).toBe('85.00');
    expect(opened.wallet.version).toBe(3);

    const version = opened.wallet.version;
    const loss = apply({
      opened,
      transaction: wager({ id: 'loss-1', externalId: 'loss-ext', kind: 'LOSS', amount: '10.00' }),
    });
    expect(loss.entry).toBeNull();
    expect(loss.transaction.affectsBalance()).toBe(false);
    expect(opened.wallet.version).toBe(version);
    expect(opened.wallet.balance.toJSON().amount).toBe('85.00');
    expect(loss.events.map((event) => event.eventType)).toEqual(['WagerTransactionProcessed']);
    expect(loss.transaction.observedBalance?.toJSON().amount).toBe('85.00');
  });

  test('aposta sem saldo rejeita e preserva a wallet', () => {
    const opened = openWith('100.00');
    const result = apply({ opened, transaction: wager({ id: 'bet-80', externalId: 'bet-80', amount: '80.00' }) });
    apply({ opened, transaction: wager({ id: 'bet-81', externalId: 'bet-81', amount: '30.00' }) });
    const rejected = apply({ opened, transaction: wager({ id: 'bet-over', externalId: 'bet-over', amount: '80.00' }) });
    expect(result.transaction.status).toBe('PROCESSED');
    expect(rejected.transaction.status).toBe('REJECTED');
    expect(rejected.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.entry).toBeNull();
    expect(opened.wallet.balance.toJSON().amount).toBe('20.00');
    expect(rejected.events[0]?.eventType).toBe('WagerTransactionRejected');
    expect(rejected.transaction.observedBalance?.toJSON().amount).toBe('20.00');
    expect(opened.wallet.version).toBe(2);
  });

  test('WIN com referência ausente espera e referência rejeitada falha na hora', () => {
    const opened = openWith('100.00');
    const waiting = apply({
      opened,
      transaction: wager({ id: 'win-wait', externalId: 'win-wait', kind: 'WIN', amount: '5.00', reference: 'missing' }),
    });
    expect(waiting.transaction.status).toBe('PENDING_REFERENCE');
    expect(waiting.transaction.attemptCount).toBe(0);
    expect(waiting.transaction.deadlineAt?.toISOString()).toBe(DEADLINE.toISOString());
    expect(waiting.entry).toBeNull();
    expect(opened.wallet.version).toBe(1);
    expect(waiting.events[0]?.eventType).toBe('WagerTransactionPendingReference');
    expect(waiting.events[0]?.version).toBe(1);
    expect(waiting.transaction.observedBalance?.toJSON().amount).toBe('100.00');

    const again = apply({
      opened,
      transaction: waiting.transaction,
      reference: null,
    });
    expect(again.events).toEqual([]);
    expect(again.transaction.attemptCount).toBe(0);

    const rejectedBet = apply({ opened, transaction: wager({ id: 'small', externalId: 'small', amount: '200.00' }) });
    expect(rejectedBet.transaction.status).toBe('REJECTED');
    const refused = apply({
      opened,
      transaction: wager({ id: 'win-bad', externalId: 'win-bad', kind: 'WIN', amount: '5.00', reference: 'small' }),
      reference: rejectedBet.transaction,
    });
    expect(refused.transaction.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('REFUND e ROLLBACK seguem kind, valor, direção e vaga única', () => {
    const opened = openWith('100.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    expect(opened.wallet.balance.toJSON().amount).toBe('75.00');

    const mismatch = apply({
      opened,
      transaction: wager({ id: 'refund-10', externalId: 'refund-10', kind: 'REFUND', amount: '10.00', reference: 'bet-ext' }),
      reference: bet.transaction,
    });
    expect(mismatch.transaction.failureCode).toBe('AMOUNT_MISMATCH');
    expect(mismatch.transaction.occupiesReversalSlot()).toBe(false);

    const otherRound = apply({
      opened,
      transaction: wager({
        id: 'refund-round',
        externalId: 'refund-round',
        kind: 'REFUND',
        amount: '25.00',
        reference: 'bet-ext',
        roundId: 'other-round',
      }),
      reference: bet.transaction,
    });
    expect(otherRound.transaction.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');

    const refund = apply({
      opened,
      transaction: wager({ id: 'refund', externalId: 'refund-ext', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: bet.transaction,
      processedReversal: mismatch.transaction,
    });
    expect(refund.transaction.status).toBe('PROCESSED');
    expect(refund.entry?.direction).toBe('CREDIT');
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');
    expect(opened.wallet.version).toBe(3);

    const second = apply({
      opened,
      transaction: wager({ id: 'refund-2', externalId: 'refund-2', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: bet.transaction,
      processedReversal: refund.transaction,
    });
    expect(second.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');

    const rollback = apply({
      opened,
      transaction: wager({
        id: 'rollback-bet',
        externalId: 'rollback-bet',
        kind: 'ROLLBACK',
        amount: '25.00',
        reference: 'bet-ext',
      }),
      reference: bet.transaction,
      processedReversal: refund.transaction,
    });
    expect(rollback.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });

  test('dois ROLLBACK da mesma BET: o primeiro credita e o segundo não muda o saldo', () => {
    const opened = openWith('100.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    const mismatch = apply({
      opened,
      transaction: wager({
        id: 'rollback-10',
        externalId: 'rollback-10',
        kind: 'ROLLBACK',
        amount: '10.00',
        reference: 'bet-ext',
      }),
      reference: bet.transaction,
    });
    expect(mismatch.transaction.failureCode).toBe('AMOUNT_MISMATCH');
    expect(opened.wallet.balance.toJSON().amount).toBe('75.00');
    const rollback = apply({
      opened,
      transaction: wager({
        id: 'rollback-bet',
        externalId: 'rollback-bet',
        kind: 'ROLLBACK',
        amount: '25.00',
        reference: 'bet-ext',
      }),
      reference: bet.transaction,
    });
    expect(rollback.transaction.status).toBe('PROCESSED');
    expect(rollback.entry?.direction).toBe('CREDIT');
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');
    const second = apply({
      opened,
      transaction: wager({
        id: 'rollback-bet-2',
        externalId: 'rollback-bet-2',
        kind: 'ROLLBACK',
        amount: '25.00',
        reference: 'bet-ext',
      }),
      reference: bet.transaction,
      processedReversal: rollback.transaction,
    });
    expect(second.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');
    expect(opened.wallet.version).toBe(3);
  });

  test('ROLLBACK de REFUND não libera a BET e o saldo do exemplo fica 75', () => {
    const opened = openWith('100.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    const refund = apply({
      opened,
      transaction: wager({ id: 'refund', externalId: 'refund-ext', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: bet.transaction,
    });
    const rollback = apply({
      opened,
      transaction: wager({
        id: 'rollback-refund',
        externalId: 'rollback-refund',
        kind: 'ROLLBACK',
        amount: '25.00',
        reference: 'refund-ext',
      }),
      reference: refund.transaction,
    });
    expect(rollback.entry?.direction).toBe('DEBIT');
    expect(opened.wallet.balance.toJSON().amount).toBe('75.00');
    const secondRefund = apply({
      opened,
      transaction: wager({ id: 'refund-2', externalId: 'refund-2', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: bet.transaction,
      processedReversal: refund.transaction,
    });
    expect(secondRefund.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('75.00');
    expect(opened.wallet.version).toBe(4);
  });

  test('ROLLBACK da WIN e REFUND da BET podem os dois ser processados', () => {
    const opened = openWith('100.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    const win = apply({
      opened,
      transaction: wager({ id: 'win', externalId: 'win-ext', kind: 'WIN', amount: '10.00', reference: 'bet-ext' }),
      reference: bet.transaction,
    });
    const rollbackWin = apply({
      opened,
      transaction: wager({
        id: 'rollback-win',
        externalId: 'rollback-win',
        kind: 'ROLLBACK',
        amount: '10.00',
        reference: 'win-ext',
      }),
      reference: win.transaction,
    });
    const refund = apply({
      opened,
      transaction: wager({ id: 'refund', externalId: 'refund-ext', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: bet.transaction,
    });
    expect(rollbackWin.transaction.status).toBe('PROCESSED');
    expect(refund.transaction.status).toBe('PROCESSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('reversão que negativaria usa código distinto e FAILED não ocupa a vaga', () => {
    const opened = openWith('25.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    const win = apply({
      opened,
      transaction: wager({ id: 'win', externalId: 'win-ext', kind: 'WIN', amount: '10.00' }),
    });
    apply({ opened, transaction: wager({ id: 'bet-2', externalId: 'bet-2', amount: '10.00' }) });
    expect(opened.wallet.balance.toJSON().amount).toBe('0.00');
    const overdraft = apply({
      opened,
      transaction: wager({
        id: 'rollback-win',
        externalId: 'rollback-win',
        kind: 'ROLLBACK',
        amount: '10.00',
        reference: 'win-ext',
      }),
      reference: win.transaction,
    });
    expect(overdraft.transaction.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(overdraft.entry).toBeNull();
    expect(opened.wallet.balance.toJSON().amount).toBe('0.00');

    const failed = wager({ id: 'refund-failed', externalId: 'refund-failed', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' });
    failed.fail('PERSISTENT_STATE_CORRUPT', NOW);
    expect(failed.occupiesReversalSlot()).toBe(false);
    expect(failed.isTerminal()).toBe(true);
    const refund = apply({
      opened,
      transaction: wager({ id: 'refund-ok', externalId: 'refund-ok', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: bet.transaction,
      processedReversal: failed,
    });
    expect(refund.transaction.status).toBe('PROCESSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('25.00');
  });

  test('referência pendente espera e kind de rollback ilegal é recusado', () => {
    const opened = openWith('100.00');
    const pendingBet = wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' });
    const waiting = apply({
      opened,
      transaction: wager({ id: 'refund-wait', externalId: 'refund-wait', kind: 'REFUND', amount: '25.00', reference: 'bet-ext' }),
      reference: pendingBet,
    });
    expect(waiting.transaction.status).toBe('PENDING_REFERENCE');
    expect(opened.wallet.version).toBe(1);

    const loss = apply({
      opened,
      transaction: wager({ id: 'loss', externalId: 'loss-ext', kind: 'LOSS', amount: '25.00' }),
    });
    const rollbackLoss = apply({
      opened,
      transaction: wager({
        id: 'rollback-loss',
        externalId: 'rollback-loss',
        kind: 'ROLLBACK',
        amount: '25.00',
        reference: 'loss-ext',
      }),
      reference: loss.transaction,
    });
    expect(rollbackLoss.transaction.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  test('estados terminais não saem e rehydrate não revalida a referência', () => {
    const opened = openWith('100.00');
    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    expect(() => bet.transaction.markPendingReference(NOW, DEADLINE, brl('75.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => bet.transaction.reject('INSUFFICIENT_FUNDS', NOW, brl('75.00'))).toThrow(InvalidTransactionStateError);
    expect(() => bet.transaction.fail('PERSISTENT_STATE_CORRUPT', NOW)).toThrow(InvalidTransactionStateError);
    expect(bet.transaction.status).toBe('PROCESSED');

    const state = bet.transaction.toState();
    state.referenceExternalTransactionId = 'not-rechecked';
    const revived = WagerTransaction.rehydrate(state);
    expect(revived.status).toBe('PROCESSED');
    expect(revived.referenceExternalTransactionId).toBe('not-rechecked');
    expect(revived.money.toJSON().amount).toBe('25.00');
    expect(() => revived.markProcessed(undefined, NOW, brl('75.00'))).toThrow(InvalidTransactionStateError);

    const pending = wager({ id: 'fresh', externalId: 'fresh' });
    pending.markPendingReference(NOW, DEADLINE, brl('100.00'));
    expect(() => pending.markPendingReference(NOW, DEADLINE, brl('100.00'))).toThrow(InvalidTransactionStateError);
    expect(() => pending.fail('INVALID_PAYLOAD', NOW)).toThrow(InvalidTransactionStateError);
    expect(pending.status).toBe('PENDING_REFERENCE');

    const rejected = wager({ id: 'rejected', externalId: 'rejected' });
    rejected.reject('INSUFFICIENT_FUNDS', NOW, brl('100.00'));
    expect(() => rejected.markProcessed(undefined, NOW, brl('100.00'))).toThrow(InvalidTransactionStateError);
    expect(() => rejected.reject('AMOUNT_MISMATCH', NOW, brl('100.00'))).toThrow(InvalidTransactionStateError);
    expect(() => rejected.fail('PERSISTENT_STATE_CORRUPT', NOW)).toThrow(InvalidTransactionStateError);
    expect(rejected.status).toBe('REJECTED');

    const failed = wager({ id: 'failed', externalId: 'failed' });
    failed.fail('PERSISTENT_STATE_CORRUPT', NOW);
    expect(() => failed.markProcessed(undefined, NOW, brl('100.00'))).toThrow(InvalidTransactionStateError);
    expect(() => failed.reject('INSUFFICIENT_FUNDS', NOW, brl('100.00'))).toThrow(InvalidTransactionStateError);
    expect(() => failed.fail('PERSISTENT_STATE_CORRUPT', NOW)).toThrow(InvalidTransactionStateError);
    expect(failed.status).toBe('FAILED');
  });

  test('replay devolve o saldo observado e conflito não gera segundo efeito', () => {
    const opened = openWith('100.00');
    const first = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    apply({ opened, transaction: wager({ id: 'bet-2', externalId: 'bet-2', amount: '10.00' }) });
    expect(opened.wallet.balance.toJSON().amount).toBe('65.00');
    const independentHash = canonicalPayloadHash({
      providerId: 'provider-a',
      externalTransactionId: 'bet-ext',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(first.transaction.payloadHash).toBe(independentHash);
    const replay = resolveIdempotency({
      existingByKey: first.transaction,
      existingByPair: first.transaction,
      incomingKey: first.transaction.idempotencyKey,
      incomingHash: independentHash,
    });
    expect(replay.decision).toBe('replay');
    if (replay.decision === 'replay') {
      expect(replay.transaction.observedBalance?.toJSON().amount).toBe('75.00');
    }
    expect(opened.wallet.balance.toJSON().amount).toBe('65.00');

    const conflict = resolveIdempotency({
      existingByKey: first.transaction,
      existingByPair: first.transaction,
      incomingKey: first.transaction.idempotencyKey,
      incomingHash: 'a'.repeat(64),
    });
    expect(conflict).toEqual({ decision: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(first.transaction.status).toBe('PROCESSED');
    expect(first.transaction.observedBalance?.toJSON().amount).toBe('75.00');

    const otherKey = resolveIdempotency({
      existingByKey: null,
      existingByPair: first.transaction,
      incomingKey: 'provider-a:other',
      incomingHash: first.transaction.payloadHash,
    });
    expect(otherKey).toEqual({ decision: 'conflict', failureCode: 'IDEMPOTENCY_KEY_MISMATCH' });
    expect(opened.wallet.version).toBe(3);
  });

  test('eventos carregam string decimal e não existe evento de FAILED', () => {
    expect([...DOMAIN_EVENT_TYPES]).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WalletBalanceChanged',
      'WagerTransactionPendingReference',
    ]);
    const opened = openWith('40.00');
    const overflow = apply({
      opened,
      transaction: wager({
        id: 'win-overflow',
        externalId: 'win-overflow',
        kind: 'WIN',
        amount: '999999999999999999.99',
      }),
    });
    expect(overflow.transaction.failureCode).toBe('AMOUNT_OVERFLOW');
    expect(opened.wallet.version).toBe(1);
    expect(opened.wallet.balance.toJSON().amount).toBe('40.00');
    const data = overflow.events[0]?.toJSON().data as { money: { amount: string } };
    expect(data.money.amount).toBe('999999999999999999.99');
    expect(overflow.events[0]?.version).toBe(1);
    expect(overflow.events[0]?.eventType).toBe('WagerTransactionRejected');
  });

  test('player ou moeda divergentes não movem a wallet e REFUND de WIN é kind inválido', () => {
    const opened = openWith('100.00');
    const otherPlayer = apply({
      opened,
      transaction: wager({ id: 'bet-player', externalId: 'bet-player', playerId: 'player-2' }),
    });
    expect(otherPlayer.transaction.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    const otherCurrency = apply({
      opened,
      transaction: wager({ id: 'bet-eur', externalId: 'bet-eur', currency: 'EUR' }),
    });
    expect(otherCurrency.transaction.failureCode).toBe('CURRENCY_MISMATCH');
    expect(opened.wallet.version).toBe(1);

    const bet = apply({ opened, transaction: wager({ id: 'bet', externalId: 'bet-ext', amount: '25.00' }) });
    const win = apply({
      opened,
      transaction: wager({ id: 'win', externalId: 'win-ext', kind: 'WIN', amount: '10.00' }),
    });
    const refundWin = apply({
      opened,
      transaction: wager({
        id: 'refund-win',
        externalId: 'refund-win',
        kind: 'REFUND',
        amount: '10.00',
        reference: 'win-ext',
      }),
      reference: win.transaction,
    });
    expect(refundWin.transaction.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    expect(bet.transaction.status).toBe('PROCESSED');
    expect(opened.wallet.balance.toJSON().amount).toBe('85.00');
  });

  test('wallet ausente rejeita sem saldo observado', () => {
    const opened = openWith('100.00');
    const absent = applyWager({
      transaction: wager({ walletId: 'missing-wallet', id: 'bet-missing', externalId: 'bet-missing' }),
      wallet: null,
      reference: null,
      processedReversal: null,
      now: NOW,
      deadlineAt: DEADLINE,
      entryId: 'entry-missing',
      correlationId: 'corr-1',
      nextEventId: () => 'event-missing',
    });
    expect(absent.transaction.failureCode).toBe('WALLET_NOT_FOUND');
    expect(absent.transaction.observedBalance).toBeUndefined();
    expect(absent.entry).toBeNull();
    expect(absent.wallet).toBeNull();
    expect(opened.wallet.version).toBe(1);
  });
});
