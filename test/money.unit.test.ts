import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../src/domain/domain-error';
import { canonicalizeAmount, Money } from '../src/domain/money/money';
import { canonicalPayloadHash } from '../src/domain/wager/payload-hash';

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

const payload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  currency: 'BRL',
};

describe('Money', () => {
  test('aceita 25.00, opera sem mutar e serializa duas casas', () => {
    const left = Money.from({ amount: '25.00', currency: 'BRL' });
    const right = Money.from({ amount: '0.10', currency: 'BRL' });
    const before = left.toJSON();
    const sum = left.add(right);
    const difference = left.subtract(right);
    const negated = left.negate();

    expect(left.toJSON()).toEqual(before);
    expect(sum).not.toBe(left);
    expect(difference).not.toBe(left);
    expect(negated).not.toBe(left);
    expect(sum.toJSON()).toEqual({ amount: '25.10', currency: 'BRL' });
    expect(difference.toJSON()).toEqual({ amount: '24.90', currency: 'BRL' });
    expect(negated.toJSON()).toEqual({ amount: '-25.00', currency: 'BRL' });
    expect(negated.isNegative()).toBe(true);
    expect(left.isPositive()).toBe(true);
    expect(Object.isFrozen(left)).toBe(true);
    expect(left.toString()).toBe('25.00 BRL');
  });

  test('0.10 mais 0.20 é 0.30', () => {
    const sum = Money.from({ amount: '0.10', currency: 'BRL' }).add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(sum.toJSON().amount).toBe('0.30');
  });

  test('preenche escala curta sem mudar o valor', () => {
    expect(canonicalizeAmount('25')).toBe('25.00');
    expect(canonicalizeAmount('25.0')).toBe('25.00');
    expect(Money.from({ amount: '25', currency: 'BRL' }).equals(Money.from({ amount: '25.00', currency: 'BRL' }))).toBe(
      true,
    );
    expect(Money.from({ amount: '0', currency: 'BRL' }).toJSON().amount).toBe('0.00');
    expect(Money.from({ amount: '0.0', currency: 'BRL' }).isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('25 e 25.00 produzem o mesmo hash', () => {
    const short = canonicalPayloadHash({ ...payload, money: { amount: '25', currency: 'BRL' } });
    const oneDecimal = canonicalPayloadHash({ ...payload, money: { amount: '25.0', currency: 'BRL' } });
    const padded = canonicalPayloadHash({ ...payload, money: { amount: '25.00', currency: 'BRL' } });
    expect(short).toBe(padded);
    expect(oneDecimal).toBe(padded);
    expect(short).toMatch(/^[0-9a-f]{64}$/);
  });

  test('recusa lixo antes de converter, inclusive número JSON e moeda minúscula', () => {
    const invalid = ['', 'NaN', 'Infinity', '-Infinity', '1e1', '25.000', '-1.00', '025.00', ' 25.00', '25.', '.50'];
    for (const amount of invalid) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(DomainError);
      try {
        Money.from({ amount, currency: 'BRL' });
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).failureCode).toBe('INVALID_PAYLOAD');
      }
    }
    expect(failureCode(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => Money.from({ amount: '25.00', currency: 'brl' }))).toBe('INVALID_PAYLOAD');
    expect(failureCode(() => Money.from({ amount: '+1.00', currency: 'BRL' }))).toBe('INVALID_PAYLOAD');
    expect(() => Money.from({ amount: '25.00', currency: 'BR' })).toThrow(DomainError);
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).currency).toBe('BRL');
    expect(Money.from({ amount: '10.00', currency: 'EUR' }).currency).toBe('EUR');
  });

  test('moedas diferentes falham e o máximo de numeric(20,2) estoura na soma', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const eur = Money.from({ amount: '1.00', currency: 'EUR' });
    expect(() => brl.add(eur)).toThrow(DomainError);
    expect(brl.equals(eur)).toBe(false);
    try {
      brl.add(eur);
    } catch (error) {
      expect((error as DomainError).failureCode).toBe('CURRENCY_MISMATCH');
    }
    expect(brl.toJSON().amount).toBe('1.00');

    const max = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
    expect(max.toJSON().amount).toBe('999999999999999999.99');
    expect(failureCode(() => Money.from({ amount: '1000000000000000000.00', currency: 'BRL' }))).toBe(
      'INVALID_PAYLOAD',
    );
    expect(failureCode(() => max.add(Money.from({ amount: '0.01', currency: 'BRL' })))).toBe('AMOUNT_OVERFLOW');
    expect(max.toJSON().amount).toBe('999999999999999999.99');
  });

  test('ida e volta de um valor fora do inteiro seguro continua string', () => {
    const amount = '9007199254740993.99';
    const money = Money.from({ amount, currency: 'BRL' });
    expect(money.toJSON().amount).toBe(amount);
    expect(money.add(Money.zero('BRL')).toJSON().amount).toBe(amount);
    expect(typeof money.toJSON().amount).toBe('string');
  });

  test('o arquivo de Money não converte por number', () => {
    const source = readFileSync(join(process.cwd(), 'src/domain/money/money.ts'), 'utf8');
    expect(source).not.toContain('toNumber');
    expect(source).not.toContain('parseFloat');
    expect(source).not.toContain('Number(');
    expect(source).not.toContain('toDecimalPlaces');
  });
});
