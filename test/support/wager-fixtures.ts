import { Money } from '../../src/domain/money/money';
import { openWallet, type OpenWalletResult } from '../../src/domain/wallet/open-wallet';
import { applyWager, type ApplyWagerResult } from '../../src/domain/wager/apply-wager';
import {
  WagerTransaction,
  type WagerTransactionKind,
} from '../../src/domain/wager/wager-transaction';

export const NOW = new Date('2026-10-29T18:00:00.000Z');
export const DEADLINE = new Date('2026-10-29T18:15:00.000Z');

export function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

export function eventIds(prefix: string): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };
}

export function openWith(amount: string, id = 'wallet-1'): OpenWalletResult {
  return openWallet({
    id,
    playerId: 'player-1',
    initialBalance: brl(amount),
    transactionId: `opening-${id}`,
    entryId: `entry-opening-${id}`,
    now: NOW,
    correlationId: 'corr-1',
    nextEventId: eventIds(`open-${id}`),
  });
}

export function wager(props: {
  id?: string;
  externalId?: string;
  kind?: WagerTransactionKind;
  amount?: string;
  currency?: string;
  reference?: string | null;
  walletId?: string;
  playerId?: string;
  roundId?: string;
  providerId?: string;
  gameId?: string;
}): WagerTransaction {
  const providerId = props.providerId ?? 'provider-a';
  const externalId = props.externalId ?? props.id ?? 'external-1';
  const kind = props.kind ?? 'BET';
  return WagerTransaction.create({
    id: props.id ?? externalId,
    providerId,
    externalTransactionId: externalId,
    idempotencyKey: `${providerId}:${externalId}`,
    walletId: props.walletId ?? 'wallet-1',
    playerId: props.playerId ?? 'player-1',
    roundId: props.roundId ?? 'round-1',
    gameId: props.gameId ?? 'fortune-chimp',
    kind,
    money: Money.from({ amount: props.amount ?? '25.00', currency: props.currency ?? 'BRL' }),
    referenceExternalTransactionId: props.reference,
    createdAt: NOW,
  });
}

export function apply(input: {
  transaction: WagerTransaction;
  opened: OpenWalletResult;
  reference?: WagerTransaction | null;
  processedReversal?: WagerTransaction | null;
  entryId?: string;
}): ApplyWagerResult {
  return applyWager({
    transaction: input.transaction,
    wallet: input.opened.wallet,
    reference: input.reference ?? null,
    processedReversal: input.processedReversal ?? null,
    now: NOW,
    deadlineAt: DEADLINE,
    entryId: input.entryId ?? `entry-${input.transaction.id}`,
    correlationId: 'corr-1',
    nextEventId: eventIds(input.transaction.id),
  });
}
