import { DomainError } from '../domain-error';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money, type MoneyProps } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  #balance: Money;
  #version: number;
  #updatedAt: Date;

  private constructor(state: {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = requireText(state.id);
    this.playerId = requireText(state.playerId);
    this.currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.createdAt = new Date(state.createdAt.getTime());
    this.#updatedAt = new Date(state.updatedAt.getTime());
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('INVALID_PAYLOAD', 'Opening balance cannot be negative');
    }
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  /** Reconstrói a wallet persistida. Não reaplica débito, crédito nem abertura. */
  static rehydrate(state: WalletState): Wallet {
    const balance = Money.from(state.balance);
    if (balance.currency !== state.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Wallet currencies differ');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new Error('Wallet version is invalid');
    }
    if (balance.isNegative()) {
      throw new DomainError('INSUFFICIENT_FUNDS', 'Wallet balance cannot be negative');
    }
    return new Wallet({
      id: state.id,
      playerId: state.playerId,
      currency: state.currency,
      balance,
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt.getTime());
  }

  debit(props: { entryId: string; transactionId: string; amount: Money; at: Date }): WalletLedgerEntry {
    return this.move('DEBIT', props);
  }

  credit(props: { entryId: string; transactionId: string; amount: Money; at: Date }): WalletLedgerEntry {
    return this.move('CREDIT', props);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this.#balance.toJSON(),
      version: this.#version,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: new Date(this.#updatedAt.getTime()),
    };
  }

  private move(
    direction: 'DEBIT' | 'CREDIT',
    props: { entryId: string; transactionId: string; amount: Money; at: Date },
  ): WalletLedgerEntry {
    if (!props.amount.isPositive()) {
      throw new DomainError('INVALID_PAYLOAD', 'Movement amount must be positive');
    }
    if (props.amount.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Movement currency differs from the wallet');
    }
    const next = direction === 'DEBIT' ? this.#balance.subtract(props.amount) : this.#balance.add(props.amount);
    if (next.isNegative()) {
      throw new DomainError('INSUFFICIENT_FUNDS', 'Balance would become negative');
    }
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      amount: props.amount.toJSON(),
      balanceBefore: this.#balance.toJSON(),
      balanceAfter: next.toJSON(),
      createdAt: props.at,
    });
    this.#balance = next;
    this.#version += 1;
    this.#updatedAt = new Date(props.at.getTime());
    return entry;
  }
}

function requireText(value: string): string {
  if (value.trim() === '' || value !== value.trim()) {
    throw new DomainError('INVALID_PAYLOAD', 'Wallet identifier is empty');
  }
  return value;
}
