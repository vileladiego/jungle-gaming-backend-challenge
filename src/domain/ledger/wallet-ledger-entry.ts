import { DomainError } from '../domain-error';
import { Money, type MoneyProps } from '../money/money';
import { type LedgerDirection } from './ledger-direction';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(state: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
  }) {
    this.id = requireText(state.id, 'Ledger entry id is empty');
    this.walletId = requireText(state.walletId, 'Ledger wallet id is empty');
    this.transactionId = requireText(state.transactionId, 'Ledger transaction id is empty');
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAt = new Date(state.createdAt.getTime());
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const money = moneyFrom(props.amount);
    const balanceBefore = moneyFrom(props.balanceBefore);
    const balanceAfter = moneyFrom(props.balanceAfter);
    if (!money.isPositive()) {
      throw new DomainError('INVALID_PAYLOAD', 'Ledger amount must be positive');
    }
    assertOneCurrency(money, balanceBefore, balanceAfter);
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new DomainError('INSUFFICIENT_FUNDS', 'Ledger balance would be negative');
    }
    const entry = new WalletLedgerEntry({
      id: props.id,
      walletId: props.walletId,
      transactionId: props.transactionId,
      direction: props.direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: props.createdAt,
    });
    if (!entry.isBalanced()) {
      throw new DomainError('INVALID_PAYLOAD', 'Ledger entry is not balanced');
    }
    return entry;
  }

  /** Reconstrói a linha persistida. Não reaplica a regra de transição. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({
      id: state.id,
      walletId: state.walletId,
      transactionId: state.transactionId,
      direction: state.direction,
      money: moneyFrom(state.amount),
      balanceBefore: moneyFrom(state.balanceBefore),
      balanceAfter: moneyFrom(state.balanceAfter),
      createdAt: state.createdAt,
    });
  }

  isBalanced(): boolean {
    if (this.money.currency !== this.balanceBefore.currency || this.money.currency !== this.balanceAfter.currency) {
      return false;
    }
    try {
      const expected =
        this.direction === 'CREDIT'
          ? this.balanceBefore.add(this.money)
          : this.balanceBefore.subtract(this.money);
      return expected.equals(this.balanceAfter);
    } catch (error) {
      if (error instanceof DomainError) {
        return false;
      }
      throw error;
    }
  }

  toState(): LedgerEntryState {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      amount: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      createdAt: new Date(this.createdAt.getTime()),
    };
  }
}

function moneyFrom(props: MoneyProps): Money {
  return props instanceof Money ? props : Money.from(props);
}

function assertOneCurrency(amount: Money, before: Money, after: Money): void {
  if (amount.currency !== before.currency || amount.currency !== after.currency) {
    throw new DomainError('CURRENCY_MISMATCH', 'Ledger currencies differ');
  }
}

function requireText(value: string, message: string): string {
  if (value.trim() === '' || value !== value.trim()) {
    throw new DomainError('INVALID_PAYLOAD', message);
  }
  return value;
}
