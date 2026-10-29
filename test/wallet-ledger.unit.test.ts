import { describe, expect, test } from 'bun:test';
import { DomainError } from '../src/domain/domain-error';
import { WalletLedgerEntry } from '../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../src/domain/money/money';
import { Wallet } from '../src/domain/wallet/wallet';
import { brl, NOW, openWith } from './support/wager-fixtures';

describe('Wallet e ledger', () => {
  test('saldo zero nasce na version 1 sem lançamento', () => {
    const opened = openWith('0.00');
    expect(opened.wallet.version).toBe(1);
    expect(opened.wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(opened.transaction).toBeNull();
    expect(opened.entry).toBeNull();
    expect(opened.events).toEqual([]);
  });

  test('saldo positivo permanece na version 1 com CREDIT desde zero', () => {
    const opened = openWith('100.00');
    expect(opened.wallet.version).toBe(1);
    expect(opened.wallet.balance.toJSON().amount).toBe('100.00');
    expect(opened.transaction?.kind).toBe('OPENING');
    expect(opened.transaction?.status).toBe('PROCESSED');
    expect(opened.transaction?.idempotencyKey).toBe('internal:wallet-1');
    expect(opened.entry?.direction).toBe('CREDIT');
    expect(opened.entry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(opened.entry?.balanceAfter.toJSON().amount).toBe('100.00');
    expect(opened.entry?.isBalanced()).toBe(true);
    expect(opened.events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const balanceChanged = opened.events[1];
    expect(balanceChanged?.version).toBe(1);
    expect(balanceChanged?.toJSON().data).toMatchObject({ walletVersion: 1, direction: 'CREDIT' });
  });

  test('version sobe só quando o saldo muda e saldo negativo é recusado', () => {
    const opened = openWith('100.00');
    const wallet = opened.wallet;
    const updated = wallet.updatedAt.getTime();
    const later = new Date('2026-10-29T19:00:00.000Z');
    const entry = wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('40.00'), at: later });
    expect(wallet.version).toBe(2);
    expect(wallet.balance.toJSON().amount).toBe('60.00');
    expect(entry.direction).toBe('DEBIT');
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.updatedAt.getTime()).toBe(later.getTime());
    expect(wallet.updatedAt.getTime()).not.toBe(updated);

    expect(() => wallet.debit({ entryId: 'e0', transactionId: 't0', amount: brl('0.00'), at: later })).toThrow(
      DomainError,
    );
    expect(wallet.version).toBe(2);

    expect(() => wallet.debit({ entryId: 'e2', transactionId: 't2', amount: brl('80.00'), at: later })).toThrow(
      DomainError,
    );
    expect(wallet.version).toBe(2);
    expect(wallet.balance.toJSON().amount).toBe('60.00');

    const credit = wallet.credit({
      entryId: 'e3',
      transactionId: 't3',
      amount: brl('10.00'),
      at: new Date('2026-10-29T20:00:00.000Z'),
    });
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(credit.balanceBefore.toJSON().amount).toBe('60.00');
    expect(credit.balanceAfter.toJSON().amount).toBe('70.00');
  });

  test('moeda da operação diferente não move a wallet', () => {
    const wallet = openWith('50.00').wallet;
    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 't1',
        amount: Money.from({ amount: '1.00', currency: 'EUR' }),
        at: NOW,
      }),
    ).toThrow(DomainError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.currency).toBe('BRL');
    const eur = Wallet.open({
      id: 'wallet-eur',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '5.00', currency: 'EUR' }),
      now: NOW,
    });
    expect(eur.currency).toBe('EUR');
    expect(eur.version).toBe(1);
  });

  test('rehydrate de wallet não reaplica o débito', () => {
    const wallet = openWith('100.00').wallet;
    wallet.debit({ entryId: 'e1', transactionId: 't1', amount: brl('30.00'), at: NOW });
    const revived = Wallet.rehydrate(wallet.toState());
    expect(revived.balance.toJSON().amount).toBe('70.00');
    expect(revived.version).toBe(2);
    expect(revived).not.toBe(wallet);
  });

  test('create do ledger recusa conta que não fecha e rehydrate só reconstrói', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'bad',
        walletId: 'wallet-1',
        transactionId: 't1',
        direction: 'DEBIT',
        amount: { amount: '5.00', currency: 'BRL' },
        balanceBefore: { amount: '10.00', currency: 'BRL' },
        balanceAfter: { amount: '10.00', currency: 'BRL' },
        createdAt: NOW,
      }),
    ).toThrow(DomainError);

    const revived = WalletLedgerEntry.rehydrate({
      id: 'bad',
      walletId: 'wallet-1',
      transactionId: 't1',
      direction: 'DEBIT',
      amount: { amount: '5.00', currency: 'BRL' },
      balanceBefore: { amount: '10.00', currency: 'BRL' },
      balanceAfter: { amount: '10.00', currency: 'BRL' },
      createdAt: NOW,
    });
    expect(revived.isBalanced()).toBe(false);
    expect(Object.isFrozen(revived)).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({
        id: 'zero',
        walletId: 'wallet-1',
        transactionId: 't1',
        direction: 'CREDIT',
        amount: { amount: '0.00', currency: 'BRL' },
        balanceBefore: { amount: '1.00', currency: 'BRL' },
        balanceAfter: { amount: '1.00', currency: 'BRL' },
        createdAt: NOW,
      }),
    ).toThrow(DomainError);
  });
});
