import type { FailureCode } from '../failure-code';
import { WagerTransaction } from './wager-transaction';

export type IdempotencyDecision =
  | { decision: 'proceed' }
  | { decision: 'replay'; transaction: WagerTransaction }
  | {
      decision: 'conflict';
      failureCode: Extract<FailureCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH' | 'IDEMPOTENCY_KEY_MISMATCH'>;
    };

/**
 * Decisão pura. Não move saldo. A unicidade que impede o segundo efeito fica no banco.
 */
export function resolveIdempotency(input: {
  existingByKey: WagerTransaction | null;
  existingByPair: WagerTransaction | null;
  incomingKey: string;
  incomingHash: string;
}): IdempotencyDecision {
  if (
    input.existingByKey !== null &&
    input.existingByPair !== null &&
    input.existingByKey.id !== input.existingByPair.id
  ) {
    throw new Error('Idempotency key and external pair point at different transactions');
  }
  const existing = input.existingByKey ?? input.existingByPair;
  if (existing === null) {
    return { decision: 'proceed' };
  }
  if (existing.idempotencyKey !== input.incomingKey) {
    return { decision: 'conflict', failureCode: 'IDEMPOTENCY_KEY_MISMATCH' };
  }
  if (existing.matchesPayload(input.incomingHash)) {
    return { decision: 'replay', transaction: existing };
  }
  return { decision: 'conflict', failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH' };
}
