import { Injectable } from '@nestjs/common';

@Injectable()
export class ProcessingMetrics {
  readonly transactionsByStatus = new Map<string, number>();
  duplicates = 0;
  retries = 0;
  dlq = 0;
  lockConflicts = 0;
  outboxLagCount = 0;
  outboxLagSeconds = 0;
  latencyCount = 0;
  latencyTotalMs = 0;

  markTransaction(status: string): void {
    this.transactionsByStatus.set(status, (this.transactionsByStatus.get(status) ?? 0) + 1);
  }

  markDuplicate(): void {
    this.duplicates += 1;
  }

  markRetry(): void {
    this.retries += 1;
  }

  markDlq(): void {
    this.dlq += 1;
  }

  markLockConflict(): void {
    this.lockConflicts += 1;
  }

  markLatency(durationMs: number): void {
    this.latencyCount += 1;
    this.latencyTotalMs += durationMs;
  }

  setOutboxLag(count: number, lagSeconds: number): void {
    this.outboxLagCount = count;
    this.outboxLagSeconds = lagSeconds;
  }
}
