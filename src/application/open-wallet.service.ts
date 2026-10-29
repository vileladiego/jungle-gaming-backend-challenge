import { Injectable } from '@nestjs/common';
import { FinancialStore } from '../persistence/financial-store';
import { uuidV7 } from '../persistence/uuid-v7';
import type { HttpResult } from './http/submission-http';
import { readMoney, readRecord, readText } from './http/read-money';

@Injectable()
export class OpenWalletService {
  constructor(private readonly store: FinancialStore) {}

  async open(body: unknown): Promise<HttpResult> {
    const record = readRecord(body);
    const playerId = readText(record.playerId, 'Player id is empty');
    const initialBalance = readMoney(record.initialBalance);
    const opened = await this.store.openWallet({
      id: uuidV7(),
      playerId,
      amount: initialBalance.amount,
      currency: initialBalance.currency,
      now: new Date(),
      correlationId: uuidV7(),
    });
    if (opened.outcome === 'conflict') {
      return { status: 409, body: { failureCode: opened.failureCode } };
    }
    return {
      status: 201,
      body: {
        id: opened.wallet.id,
        playerId: opened.wallet.playerId,
        balance: opened.wallet.balance.toJSON(),
        version: opened.wallet.version,
      },
    };
  }
}
