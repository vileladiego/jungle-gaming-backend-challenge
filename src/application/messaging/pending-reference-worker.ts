import { Inject, Injectable } from '@nestjs/common';
import { pollIntervalMs } from '../../config/async-config';
import { classifyPostgresError } from '../../persistence/postgres-error';
import { FinancialStore } from '../../persistence/financial-store';
import { logJson } from './json-log';
import { ProcessingMetrics } from './processing-metrics';

@Injectable()
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(FinancialStore) private readonly store: FinancialStore,
    @Inject(ProcessingMetrics) private readonly metrics: ProcessingMetrics,
  ) {}

  start(): Promise<void> {
    if (this.running && this.loop !== undefined) {
      return this.loop;
    }
    this.running = true;
    this.loop = this.poll();
    return this.loop;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  async once(): Promise<boolean> {
    const id = await this.store.claimPendingReference();
    if (id === null) {
      return false;
    }
    try {
      const outcome = await this.store.resolvePendingReference(id);
      if (outcome === 'waiting') {
        this.metrics.markRetry();
      }
      if (outcome === 'resolved') {
        this.metrics.markTransaction('PROCESSED');
      }
      if (outcome === 'rejected') {
        this.metrics.markTransaction('REJECTED');
      }
      logJson('info', 'pending reference resolution finished', { transactionId: id, status: outcome });
      return true;
    } catch (error) {
      const classified = classifyPostgresError(error);
      if (classified.kind === 'transient' && classified.code === '55P03') {
        this.metrics.markLockConflict();
      } else {
        this.metrics.markRetry();
      }
      logJson('warn', 'pending reference resolution rolled back', {
        transactionId: id,
        failureCode: classified.kind === 'transient' ? classified.code : 'Error',
      });
      return true;
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      const worked = await this.once();
      if (!worked) {
        await sleep(pollIntervalMs());
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
