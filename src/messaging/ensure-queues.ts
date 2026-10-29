import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  INPUT_MAX_RECEIVE_COUNT,
  INPUT_VISIBILITY_TIMEOUT_SECONDS,
  WAGER_DOMAIN_EVENTS_QUEUE,
  WAGER_TRANSACTIONS_DLQ,
  WAGER_TRANSACTIONS_QUEUE,
} from './queue-names';

export async function ensureQueues(client: SQSClient): Promise<void> {
  await createFifoQueue(client, WAGER_TRANSACTIONS_DLQ, {});
  const dlqArn = await readQueueArn(client, WAGER_TRANSACTIONS_DLQ);
  const redrivePolicy = JSON.stringify({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount: INPUT_MAX_RECEIVE_COUNT,
  });
  await createFifoQueue(client, WAGER_TRANSACTIONS_QUEUE, {
    VisibilityTimeout: String(INPUT_VISIBILITY_TIMEOUT_SECONDS),
    RedrivePolicy: redrivePolicy,
  });
  await createFifoQueue(client, WAGER_DOMAIN_EVENTS_QUEUE, {});
}

async function createFifoQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<void> {
  await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        ...attributes,
      },
    }),
  );
}

async function readQueueArn(client: SQSClient, name: string): Promise<string> {
  const url = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (url.QueueUrl === undefined) {
    throw new Error(`Queue URL missing for ${name}`);
  }
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const arn = attributes.Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error(`Queue ARN missing for ${name}`);
  }
  return arn;
}
