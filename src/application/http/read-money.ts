import { DomainError } from '../../domain/domain-error';

/** Contrato HTTP. Número JSON não vira string. A regra lexical fica em Money.from. */
export function readMoney(value: unknown): { amount: string; currency: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_PAYLOAD', 'Money object is required');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.amount !== 'string' || typeof record.currency !== 'string') {
    throw new DomainError('INVALID_PAYLOAD', 'Money amount and currency must be strings');
  }
  return { amount: record.amount, currency: record.currency };
}

export function readText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new DomainError('INVALID_PAYLOAD', message);
  }
  return value;
}

export function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_PAYLOAD', 'JSON object is required');
  }
  return value as Record<string, unknown>;
}
