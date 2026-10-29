import { Injectable } from '@nestjs/common';
import { DomainError } from '../domain/domain-error';
import type { WagerTransactionKind } from '../domain/wager/wager-transaction';
import { FinancialStore } from '../persistence/financial-store';
import { uuidV7 } from '../persistence/uuid-v7';
import { readMoney, readRecord, readText } from './http/read-money';
import { submissionHttp, type HttpResult } from './http/submission-http';

const KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

@Injectable()
export class SubmitWagerService {
  constructor(private readonly store: FinancialStore) {}

  async submit(body: unknown, idempotencyKey: unknown): Promise<HttpResult> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new DomainError('INVALID_PAYLOAD', 'Idempotency-Key is required');
    }
    const record = readRecord(body);
    const providerId = readText(record.providerId, 'Provider id is empty');
    const externalTransactionId = readText(record.externalTransactionId, 'External transaction id is empty');
    const money = readMoney(record.money);
    const result = await this.store.submitWager({
      id: uuidV7(),
      providerId,
      externalTransactionId,
      idempotencyKey,
      walletId: readText(record.walletId, 'Wallet id is empty'),
      playerId: readText(record.playerId, 'Player id is empty'),
      roundId: readText(record.roundId, 'Round id is empty'),
      gameId: readText(record.gameId, 'Game id is empty'),
      kind: readKind(record.kind),
      amount: money.amount,
      currency: money.currency,
      referenceExternalTransactionId: readReference(record),
      now: new Date(),
      correlationId: uuidV7(),
    });
    return submissionHttp(result);
  }
}

function readKind(value: unknown): Exclude<WagerTransactionKind, 'OPENING'> {
  if (typeof value !== 'string' || !KINDS.some((kind) => kind === value)) {
    throw new DomainError('INVALID_PAYLOAD', 'Kind is not accepted on this edge');
  }
  return value as Exclude<WagerTransactionKind, 'OPENING'>;
}

function readReference(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'referenceExternalTransactionId')) {
    return undefined;
  }
  return readText(record.referenceExternalTransactionId, 'Reference is empty');
}
