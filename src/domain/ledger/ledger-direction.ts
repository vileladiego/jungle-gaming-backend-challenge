export const LEDGER_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;

export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];
