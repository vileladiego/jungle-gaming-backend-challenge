import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/domain-error';
import { requireEnv } from '../config/env';

interface CursorPayload {
  walletId: string;
  createdAt: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeLedgerCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', cursorSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function decodeLedgerCursor(token: string, walletId: string): { createdAt: string; id: string } {
  const parts = token.split('.');
  const body = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || body === undefined || signature === undefined || body === '' || signature === '') {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  const expected = createHmac('sha256', cursorSecret()).update(body).digest('base64url');
  const received = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (record.walletId !== walletId || typeof record.createdAt !== 'string' || typeof record.id !== 'string') {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  if (!UUID.test(record.id) || record.createdAt.trim() === '') {
    throw new DomainError('INVALID_PAYLOAD', 'Cursor is invalid');
  }
  return { createdAt: record.createdAt, id: record.id };
}

function cursorSecret(): string {
  return requireEnv('LEDGER_CURSOR_SECRET');
}
