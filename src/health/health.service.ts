import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { SQS_CLIENT } from '../messaging/messaging.module';
import { probeSqs } from '../messaging/sqs-probe';
import { probePostgres } from '../persistence/postgres-probe';
import type { LiveReport, ReadyReport } from './health-report';

@Injectable()
export class HealthService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  live(): LiveReport {
    return { status: 'ok' };
  }

  async ready(): Promise<ReadyReport> {
    const [postgres, sqs] = await Promise.all([
      probePostgres(this.orm),
      probeSqs(this.sqs),
    ]);
    const status = postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable';
    return { status, postgres, sqs };
  }
}
