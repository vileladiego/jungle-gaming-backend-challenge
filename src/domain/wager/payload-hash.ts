import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain-error';
import { canonicalizeAmount, canonicalizeCurrency } from '../money/money';

export interface CanonicalPayloadInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
  messageId?: string;
  occurredAt?: string;
  idempotencyKey?: string;
}

export function canonicalPayloadHash(input: CanonicalPayloadInput): string {
  if (
    'referenceExternalTransactionId' in input &&
    (input.referenceExternalTransactionId === null || input.referenceExternalTransactionId === '')
  ) {
    throw new DomainError('INVALID_PAYLOAD', 'Reference is empty');
  }
  const body: Record<string, unknown> = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: canonicalizeAmount(input.money.amount),
      currency: canonicalizeCurrency(input.money.currency),
    },
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  };
  if (typeof input.referenceExternalTransactionId === 'string') {
    body.referenceExternalTransactionId = input.referenceExternalTransactionId;
  }
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

export function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const sorted: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    sorted[key] = sortKeys(nested);
  }
  return sorted;
}
