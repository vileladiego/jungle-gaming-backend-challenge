import { describe, expect, test } from 'bun:test';
import { backoffDelayMs } from '../src/config/async-config';
import { logJson } from '../src/application/messaging/json-log';
import { parseWagerMessage } from '../src/application/messaging/wager-message';

describe('mensagem de aposta', () => {
  test('aceita o envelope e rejeita número, OPENING e provedor divergente', () => {
    const parsed = parseWagerMessage(envelope('10.00'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.message.amount).toBe('10.00');
    expect(parsed.message.payloadHash).toHaveLength(64);

    const numeric = parseWagerMessage({
      ...envelope('10.00'),
      data: { ...envelope('10.00').data, money: { amount: 10, currency: 'BRL' } },
    });
    expect(numeric.ok).toBe(false);

    const opening = parseWagerMessage({
      ...envelope('10.00'),
      data: { ...envelope('10.00').data, kind: 'OPENING' },
    });
    expect(opening.ok).toBe(false);

    const otherProvider = parseWagerMessage(envelope('10.00'), { providerId: 'other' });
    expect(otherProvider.ok).toBe(false);
  });

  test('backoff dobra até o teto', () => {
    expect(backoffDelayMs(1, 50, 200)).toBe(50);
    expect(backoffDelayMs(2, 50, 200)).toBe(100);
    expect(backoffDelayMs(3, 50, 200)).toBe(200);
    expect(backoffDelayMs(4, 50, 200)).toBe(200);
  });

  test('log JSON não carrega corpo financeiro', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      logJson('info', 'wager message committed', {
        messageId: 'msg-1',
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'prov',
        correlationId: 'corr-1',
        status: 'PROCESSED',
      });
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.amount).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('10.00');
  });
});

function envelope(amount: string): {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
} {
  return {
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-29T15:00:00.000Z',
    data: {
      providerId: 'prov',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'prov:ext-1',
      playerId: 'player-1',
      walletId: '00000000-0000-7000-8000-000000000001',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}
