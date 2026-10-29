import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { requireEnv } from '../config/env';

export function createSqsClient(endpoint = requireEnv('AWS_ENDPOINT_URL')): SQSClient {
  return new SQSClient({
    region: requireEnv('AWS_REGION'),
    endpoint,
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 2000,
      requestTimeout: 2000,
      throwOnRequestTimeout: true,
    }),
    credentials: {
      accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    },
  });
}
