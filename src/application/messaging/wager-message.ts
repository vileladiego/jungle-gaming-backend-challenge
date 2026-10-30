import { DomainError } from '../../domain/domain-error';
import { canonicalPayloadHash } from '../../domain/wager/payload-hash';
import type { WagerTransactionKind } from '../../domain/wager/wager-transaction';
import type { ProviderIdentity } from '../provider-identity.port';
import { readMoney, readRecord, readText } from '../http/read-money';

const KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export interface ParsedWagerMessage {
  messageId: string;
  occurredAt: Date;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, 'OPENING'>;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string;
  payloadHash: string;
}

export type ParseWagerMessageResult =
  | { ok: true; message: ParsedWagerMessage }
  | { ok: false; messageId: string; failureCode: 'INVALID_PAYLOAD' | 'REFERENCE_REQUIRED' };

export function parseWagerMessage(body: unknown, identity?: ProviderIdentity): ParseWagerMessageResult {
  const fallbackId = 'unparsed';
  try {
    const envelope = readRecord(body);
    const messageId = readText(envelope.messageId, 'Message id is empty');
    if (envelope.type !== 'WagerTransactionRequested') {
      return { ok: false, messageId, failureCode: 'INVALID_PAYLOAD' };
    }
    const occurredAt = readOccurredAt(envelope.occurredAt);
    const data = readRecord(envelope.data);
    const providerId = readText(data.providerId, 'Provider id is empty');
    if (identity !== undefined && identity.providerId !== providerId) {
      return { ok: false, messageId, failureCode: 'INVALID_PAYLOAD' };
    }
    const externalTransactionId = readText(data.externalTransactionId, 'External transaction id is empty');
    const idempotencyKey = readText(data.idempotencyKey, 'Idempotency key is empty');
    if (idempotencyKey !== `${providerId}:${externalTransactionId}`) {
      return { ok: false, messageId, failureCode: 'INVALID_PAYLOAD' };
    }
    const money = readMoney(data.money);
    const kind = readKind(data.kind);
    const reference = readReference(data);
    const walletId = readText(data.walletId, 'Wallet id is empty');
    const playerId = readText(data.playerId, 'Player id is empty');
    const roundId = readText(data.roundId, 'Round id is empty');
    const gameId = readText(data.gameId, 'Game id is empty');
    return {
      ok: true,
      message: {
        messageId,
        occurredAt,
        providerId,
        externalTransactionId,
        idempotencyKey,
        walletId,
        playerId,
        roundId,
        gameId,
        kind,
        amount: money.amount,
        currency: money.currency,
        referenceExternalTransactionId: reference,
        payloadHash: canonicalPayloadHash({
          providerId,
          externalTransactionId,
          playerId,
          walletId,
          roundId,
          gameId,
          kind,
          money,
          referenceExternalTransactionId: reference,
        }),
      },
    };
  } catch (error) {
    const messageId = readMessageId(body) ?? fallbackId;
    if (error instanceof DomainError && error.failureCode === 'REFERENCE_REQUIRED') {
      return { ok: false, messageId, failureCode: 'REFERENCE_REQUIRED' };
    }
    return { ok: false, messageId, failureCode: 'INVALID_PAYLOAD' };
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

function readOccurredAt(value: unknown): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('INVALID_PAYLOAD', 'occurredAt is empty');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError('INVALID_PAYLOAD', 'occurredAt is not a timestamp');
  }
  return parsed;
}

function readMessageId(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const messageId = (body as { messageId?: unknown }).messageId;
  return typeof messageId === 'string' && messageId.trim() !== '' ? messageId : undefined;
}
