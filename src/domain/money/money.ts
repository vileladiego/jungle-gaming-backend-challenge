import Decimal from 'decimal.js';
import { DomainError } from '../domain-error';

Decimal.set({ precision: 40 });

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_ABS = new Decimal('999999999999999999.99');

export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Única porta lexical de amount. Casa a string antes de existir um Decimal.
 * Preenche até duas casas sem mudar o valor.
 */
export function canonicalizeAmount(amount: unknown): string {
  if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
    throw new DomainError('INVALID_PAYLOAD', 'Amount is not a canonical decimal string');
  }
  const dot = amount.indexOf('.');
  if (dot === -1) {
    return `${amount}.00`;
  }
  const fraction = amount.slice(dot + 1);
  if (fraction.length === 1) {
    return `${amount}0`;
  }
  return amount;
}

export function canonicalizeCurrency(currency: unknown): string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new DomainError('INVALID_PAYLOAD', 'Currency is not an uppercase ISO code');
  }
  return currency;
}

function formatExact(value: Decimal): string {
  if (!value.isFinite() || value.decimalPlaces() > 2) {
    throw new Error('Money produced a scale above 2');
  }
  if (value.abs().gt(MAX_ABS)) {
    throw new DomainError('AMOUNT_OVERFLOW', 'Amount exceeds numeric(20,2)');
  }
  const fixed = value.abs().toFixed(2);
  return value.isNegative() ? `-${fixed}` : fixed;
}

export class Money {
  readonly #value: Decimal;
  readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    this.#value = value;
    this.currency = currency;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const currency = canonicalizeCurrency(props.currency);
    const canonical = canonicalizeAmount(props.amount);
    const value = new Decimal(canonical);
    if (formatExact(value) !== canonical) {
      throw new Error('Canonical amount changed when parsed');
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.fromDecimal(this.#value.plus(other.#value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.fromDecimal(this.#value.minus(other.#value));
  }

  negate(): Money {
    return this.fromDecimal(this.#value.negated());
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.gt(0);
  }

  isNegative(): boolean {
    return this.#value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lt(other.#value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: formatExact(this.#value), currency: this.currency };
  }

  toString(): string {
    const props = this.toJSON();
    return `${props.amount} ${props.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Money currencies differ');
    }
  }

  private fromDecimal(value: Decimal): Money {
    formatExact(value);
    return new Money(value, this.currency);
  }
}
