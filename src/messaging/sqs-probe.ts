import { ListQueuesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DependencyStatus } from '../health/health-report';

export async function probeSqs(client: SQSClient): Promise<DependencyStatus> {
  try {
    await client.send(new ListQueuesCommand({ MaxResults: 1 }));
    return 'up';
  } catch {
    return 'down';
  }
}
