import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../domain/domain-error';
import { Money } from '../domain/money/money';
import { FinancialStore } from '../persistence/financial-store';
import type { HttpResult } from './http/submission-http';

@Injectable()
export class ReconcileWalletService {
  readonly #log = new Logger(ReconcileWalletService.name);
  #divergences = 0;

  constructor(private readonly store: FinancialStore) {}

  get divergences(): number {
    return this.#divergences;
  }

  async reconcile(walletId: string): Promise<HttpResult> {
    const snapshot = await this.store.readForReconciliation(walletId);
    if (snapshot === null) {
      return { status: 404, body: {} };
    }
    const stored = snapshot.wallet.balance;
    let calculated = Money.zero(stored.currency);
    try {
      for (const entry of snapshot.entries) {
        calculated =
          entry.direction === 'CREDIT' ? calculated.add(entry.money) : calculated.subtract(entry.money);
      }
    } catch (error) {
      if (error instanceof DomainError) {
        this.recordDivergence(walletId, snapshot.entries.length);
        return {
          status: 200,
          body: {
            walletId,
            storedBalance: stored.toJSON(),
            consistent: false,
            checkedEntries: snapshot.entries.length,
          },
        };
      }
      throw error;
    }
    const consistent = stored.equals(calculated);
    const difference = stored.subtract(calculated);
    if (!consistent) {
      this.recordDivergence(walletId, snapshot.entries.length);
    }
    return {
      status: 200,
      body: {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: snapshot.entries.length,
      },
    };
  }

  private recordDivergence(walletId: string, checkedEntries: number): void {
    this.#divergences += 1;
    this.#log.warn(`reconciliation diverged walletId=${walletId} checkedEntries=${checkedEntries}`);
  }
}
