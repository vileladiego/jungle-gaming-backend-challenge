import { readPositiveInt } from './env';

export function claimLeaseMs(): number {
  return readPositiveInt('CLAIM_LEASE_MS', 30_000);
}

export function pendingMaxAttempts(): number {
  return readPositiveInt('PENDING_MAX_ATTEMPTS', 8);
}

export function pendingBackoffBaseMs(): number {
  return readPositiveInt('PENDING_BACKOFF_BASE_MS', 1000);
}

export function pendingBackoffCapMs(): number {
  return readPositiveInt('PENDING_BACKOFF_CAP_MS', 30_000);
}

export function outboxBackoffBaseMs(): number {
  return readPositiveInt('OUTBOX_BACKOFF_BASE_MS', 1000);
}

export function outboxBackoffCapMs(): number {
  return readPositiveInt('OUTBOX_BACKOFF_CAP_MS', 60_000);
}

export function pollIntervalMs(): number {
  return readPositiveInt('POLL_INTERVAL_MS', 1000);
}

/** delay(n) = min(teto, base * 2^(n - 1)), com n já incrementado. */
export function backoffDelayMs(attemptAfterIncrement: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, attemptAfterIncrement - 1);
  const delay = baseMs * 2 ** exponent;
  return Math.min(capMs, delay);
}
