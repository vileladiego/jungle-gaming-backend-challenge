import type { SubmitWagerPersistenceResult } from '../../persistence/financial-store';

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

export function submissionHttp(result: SubmitWagerPersistenceResult): HttpResult {
  if (result.outcome === 'duplicate' || result.outcome === 'inbox-held') {
    throw new Error('Inbox disposition is not an HTTP result');
  }
  if (result.outcome === 'conflict') {
    return { status: 409, body: { failureCode: result.failureCode } };
  }
  const replay = result.outcome === 'replay';
  const transaction = result.transaction;
  if (transaction.status === 'PROCESSED') {
    return {
      status: 200,
      body: {
        transactionId: transaction.id,
        status: transaction.status,
        balance: transaction.observedBalance?.toJSON(),
        idempotentReplay: replay,
      },
    };
  }
  if (transaction.status === 'PENDING_REFERENCE') {
    return {
      status: 202,
      body: {
        transactionId: transaction.id,
        status: transaction.status,
        balance: transaction.observedBalance?.toJSON(),
        idempotentReplay: replay,
      },
    };
  }
  if (transaction.status === 'REJECTED') {
    const body: Record<string, unknown> = {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      idempotentReplay: replay,
    };
    if (transaction.observedBalance !== undefined) {
      body.balance = transaction.observedBalance.toJSON();
    }
    return { status: 422, body };
  }
  return {
    status: 500,
    body: {
      transactionId: transaction.id,
      status: 'FAILED',
      failureCode: 'PERSISTENT_STATE_CORRUPT',
      idempotentReplay: replay,
    },
  };
}
