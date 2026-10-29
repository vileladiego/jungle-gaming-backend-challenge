import { Injectable } from '@nestjs/common';
import { DomainError } from '../domain/domain-error';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import type { WagerTransaction } from '../domain/wager/wager-transaction';
import { FinancialStore } from '../persistence/financial-store';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import type { HttpResult } from './http/submission-http';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@Injectable()
export class WalletQueryService {
  constructor(private readonly store: FinancialStore) {}

  async wallet(walletId: string): Promise<HttpResult> {
    const wallet = await this.store.loadWallet(walletId);
    if (wallet === null) {
      return { status: 404, body: {} };
    }
    return {
      status: 200,
      body: {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      },
    };
  }

  async ledger(walletId: string, cursor: unknown, limit: unknown): Promise<HttpResult> {
    const wallet = await this.store.loadWallet(walletId);
    if (wallet === null) {
      return { status: 404, body: {} };
    }
    const pageSize = readLimit(limit);
    const after = readCursor(cursor, walletId);
    const rows = await this.store.listLedger(walletId, after, pageSize + 1);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > pageSize && last !== undefined
        ? encodeLedgerCursor({
            walletId,
            createdAt: last.cursorCreatedAt,
            id: last.entry.id,
          })
        : null;
    return {
      status: 200,
      body: {
        entries: page.map((row) => ledgerJson(row.entry)),
        nextCursor,
      },
    };
  }

  async transaction(transactionId: string): Promise<HttpResult> {
    const transaction = await this.store.loadWager(transactionId);
    if (transaction === null) {
      return { status: 404, body: {} };
    }
    return { status: 200, body: transactionJson(transaction) };
  }

  async transactionByExternal(providerId: string, externalTransactionId: string): Promise<HttpResult> {
    const transaction = await this.store.loadWagerByPair(providerId, externalTransactionId);
    if (transaction === null) {
      return { status: 404, body: {} };
    }
    return { status: 200, body: transactionJson(transaction) };
  }
}

function readCursor(cursor: unknown, walletId: string): { createdAt: string; id: string } | null {
  if (cursor === undefined) {
    return null;
  }
  if (typeof cursor !== 'string' || cursor === '') {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  return decodeLedgerCursor(cursor, walletId);
}

function readLimit(value: unknown): number {
  if (value === undefined || value === '') {
    return DEFAULT_LIMIT;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new DomainError('INVALID_PAYLOAD', 'Limit is invalid');
  }
  const limit = Number(value);
  if (limit > MAX_LIMIT) {
    throw new DomainError('INVALID_PAYLOAD', 'Limit is invalid');
  }
  return limit;
}

function ledgerJson(entry: WalletLedgerEntry): Record<string, unknown> {
  const state = entry.toState();
  return {
    id: state.id,
    transactionId: state.transactionId,
    direction: state.direction,
    amount: state.amount,
    balanceBefore: state.balanceBefore,
    balanceAfter: state.balanceAfter,
    createdAt: state.createdAt.toISOString(),
  };
}

function transactionJson(transaction: WagerTransaction): Record<string, unknown> {
  const state = transaction.toState();
  const body: Record<string, unknown> = {
    transactionId: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    walletId: state.walletId,
    playerId: state.playerId,
    roundId: state.roundId,
    gameId: state.gameId,
    kind: state.kind,
    money: state.money,
    status: state.status,
  };
  if (state.failureCode !== undefined) {
    body.failureCode = state.failureCode;
  }
  if (state.observedBalance !== undefined) {
    body.balance = state.observedBalance;
  }
  if (state.referenceExternalTransactionId !== undefined) {
    body.referenceExternalTransactionId = state.referenceExternalTransactionId;
  }
  return body;
}
