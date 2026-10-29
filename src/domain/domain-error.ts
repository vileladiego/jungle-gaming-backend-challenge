import type { FailureCode } from './failure-code';

export class DomainError extends Error {
  readonly failureCode: FailureCode;

  constructor(failureCode: FailureCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.failureCode = failureCode;
  }
}

/** Transição ilegal. Erro de programação, não rejeição de negócio. */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}
