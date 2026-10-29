import { Module } from '@nestjs/common';
import { createSqsClient } from './sqs-client';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () => createSqsClient(),
    },
  ],
  exports: [SQS_CLIENT],
})
export class MessagingModule {}
