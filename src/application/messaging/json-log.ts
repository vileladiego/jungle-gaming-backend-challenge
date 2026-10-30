const FIELDS = [
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'eventId',
  'status',
  'failureCode',
  'durationMs',
] as const;

export type LogFields = Partial<Record<(typeof FIELDS)[number], string | number>>;

export function logJson(level: 'info' | 'warn' | 'error', message: string, fields: LogFields = {}): void {
  const line: Record<string, string | number> = {
    time: new Date().toISOString(),
    level,
    message,
  };
  for (const key of FIELDS) {
    const value = fields[key];
    if (value !== undefined) {
      line[key] = value;
    }
  }
  console.log(JSON.stringify(line));
}
