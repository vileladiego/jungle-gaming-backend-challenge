import { DomainError, InvalidTransactionStateError } from '../domain-error';
import { isPersistedRejection, type FailureCode } from '../failure-code';
import { type LedgerDirection } from '../ledger/ledger-direction';
import { Money, type MoneyProps } from '../money/money';
import { canonicalPayloadHash, sameHash } from './payload-hash';

export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerTransactionKind = (typeof WAGER_KINDS)[number];

export const WAGER_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;
export type WagerTransactionStatus = (typeof WAGER_STATUSES)[number];

const EXTERNAL_KINDS = new Set<WagerTransactionKind>(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);
const PROVIDER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | null;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: MoneyProps;
  attemptCount: number;
  nextAttemptAt?: Date;
  deadlineAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  #status: WagerTransactionStatus;
  #referenceTransactionId?: string;
  #failureCode?: FailureCode;
  #processedAt?: Date;
  #observedBalance?: Money;
  #attemptCount: number;
  #nextAttemptAt?: Date;
  #deadlineAt?: Date;

  private constructor(state: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
    createdAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
    observedBalance?: Money;
    attemptCount: number;
    nextAttemptAt?: Date;
    deadlineAt?: Date;
  }) {
    this.id = requireText(state.id);
    this.providerId = requireText(state.providerId);
    this.externalTransactionId = requireText(state.externalTransactionId);
    this.idempotencyKey = requireText(state.idempotencyKey);
    this.payloadHash = requireText(state.payloadHash);
    this.walletId = requireText(state.walletId);
    this.playerId = requireText(state.playerId);
    this.roundId = requireText(state.roundId);
    this.gameId = requireText(state.gameId);
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt.getTime());
    this.#status = state.status;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#failureCode = state.failureCode;
    this.#processedAt = copyDate(state.processedAt);
    this.#observedBalance = state.observedBalance;
    this.#attemptCount = state.attemptCount;
    this.#nextAttemptAt = copyDate(state.nextAttemptAt);
    this.#deadlineAt = copyDate(state.deadlineAt);
  }

  /** Nasce PENDING. Recusa OPENING e contrato inválido antes de existir efeito. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_KINDS.has(props.kind)) {
      throw new DomainError('INVALID_PAYLOAD', 'Kind is not accepted on this edge');
    }
    assertExternalProvider(props.providerId);
    assertIdempotencyKey(props);
    const reference = readExternalReference(props);
    if (props.money.isZero() || props.money.isNegative()) {
      throw new DomainError('INVALID_PAYLOAD', 'External amount must be positive');
    }
    return new WagerTransaction({
      ...identity(props),
      money: props.money,
      referenceExternalTransactionId: reference,
      payloadHash: hashOf(props, reference),
      status: 'PENDING',
      attemptCount: 0,
    });
  }

  /** Abertura interna. Nasce PROCESSED, com key no prefixo internal:. */
  static createOpening(props: CreateWagerTransactionProps & { observedBalance: Money }): WagerTransaction {
    if (props.kind !== 'OPENING') {
      throw new DomainError('INVALID_PAYLOAD', 'Opening factory requires OPENING');
    }
    if (props.providerId !== 'internal') {
      throw new DomainError('INVALID_PAYLOAD', 'Opening provider must be internal');
    }
    assertIdempotencyKey(props);
    if (!props.idempotencyKey.startsWith('internal:')) {
      throw new DomainError('INVALID_PAYLOAD', 'Opening key must use the internal prefix');
    }
    if (props.referenceExternalTransactionId != null) {
      throw new DomainError('INVALID_PAYLOAD', 'Opening does not accept a reference');
    }
    if (!props.money.isPositive() || !props.observedBalance.equals(props.money)) {
      throw new DomainError('INVALID_PAYLOAD', 'Opening amount must be the positive balance');
    }
    const createdAt = new Date(props.createdAt.getTime());
    return new WagerTransaction({
      ...identity(props),
      money: props.money,
      payloadHash: hashOf(props, undefined),
      status: 'PROCESSED',
      processedAt: createdAt,
      observedBalance: props.observedBalance,
      attemptCount: 0,
    });
  }

  /** Reconstrói o estado persistido, inclusive terminal, sem reaplicar a regra. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      money: Money.from(state.money),
      referenceExternalTransactionId: state.referenceExternalTransactionId,
      createdAt: state.createdAt,
      status: state.status,
      referenceTransactionId: state.referenceTransactionId,
      failureCode: state.failureCode,
      processedAt: state.processedAt,
      observedBalance: state.observedBalance === undefined ? undefined : Money.from(state.observedBalance),
      attemptCount: state.attemptCount,
      nextAttemptAt: state.nextAttemptAt,
      deadlineAt: state.deadlineAt,
    });
  }

  get status(): WagerTransactionStatus {
    return this.#status;
  }

  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this.#failureCode;
  }

  get processedAt(): Date | undefined {
    return copyDate(this.#processedAt);
  }

  get observedBalance(): Money | undefined {
    return this.#observedBalance;
  }

  get attemptCount(): number {
    return this.#attemptCount;
  }

  get nextAttemptAt(): Date | undefined {
    return copyDate(this.#nextAttemptAt);
  }

  get deadlineAt(): Date | undefined {
    return copyDate(this.#deadlineAt);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertOpen();
    if ((this.kind === 'REFUND' || this.kind === 'ROLLBACK') && referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError('Processed reversal requires the referenced transaction');
    }
    this.#status = 'PROCESSED';
    this.#referenceTransactionId = referenceTransactionId;
    this.#processedAt = new Date(at.getTime());
    this.#observedBalance = observedBalance;
    this.#failureCode = undefined;
  }

  markPendingReference(at: Date, deadlineAt: Date, observedBalance: Money): void {
    this.assertStatus('PENDING');
    this.#status = 'PENDING_REFERENCE';
    this.#nextAttemptAt = new Date(at.getTime());
    this.#deadlineAt = new Date(deadlineAt.getTime());
    this.#observedBalance = observedBalance;
    this.#attemptCount = 0;
  }

  /**
   * Troca só o prazo já persistível. O relógio da submissão não é o do PostgreSQL.
   * Não mexe em status, saldo, contador nem snapshot.
   */
  alignPendingSchedule(nextAttemptAt: Date, deadlineAt: Date): void {
    this.assertStatus('PENDING_REFERENCE');
    this.#nextAttemptAt = new Date(nextAttemptAt.getTime());
    this.#deadlineAt = new Date(deadlineAt.getTime());
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertOpen();
    if (!isPersistedRejection(code)) {
      throw new InvalidTransactionStateError('Rejection code is not a persisted business failure');
    }
    this.#status = 'REJECTED';
    this.#failureCode = code;
    this.#processedAt = new Date(at.getTime());
    this.#observedBalance = observedBalance;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertOpen();
    if (code !== 'PERSISTENT_STATE_CORRUPT') {
      throw new InvalidTransactionStateError('FAILED only records persistent state corruption');
    }
    this.#status = 'FAILED';
    this.#failureCode = code;
    this.#processedAt = new Date(at.getTime());
  }

  isTerminal(): boolean {
    return this.#status === 'PROCESSED' || this.#status === 'REJECTED' || this.#status === 'FAILED';
  }

  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }

  matchesPayload(payloadHash: string): boolean {
    return sameHash(this.payloadHash, payloadHash);
  }

  occupiesReversalSlot(): boolean {
    return this.#status === 'PROCESSED' && (this.kind === 'REFUND' || this.kind === 'ROLLBACK');
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === 'BET') {
      return 'DEBIT';
    }
    if (this.kind === 'WIN' || this.kind === 'REFUND' || this.kind === 'OPENING') {
      return 'CREDIT';
    }
    if (this.kind === 'ROLLBACK') {
      if (reference?.kind === 'BET') {
        return 'CREDIT';
      }
      if (reference?.kind === 'WIN' || reference?.kind === 'REFUND') {
        return 'DEBIT';
      }
      throw new DomainError('REFERENCE_KIND_NOT_ALLOWED', 'Rollback reference kind is not reversible');
    }
    throw new DomainError('INVALID_PAYLOAD', 'Kind does not move the balance');
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: new Date(this.createdAt.getTime()),
      status: this.#status,
      referenceTransactionId: this.#referenceTransactionId,
      failureCode: this.#failureCode,
      processedAt: copyDate(this.#processedAt),
      observedBalance: this.#observedBalance?.toJSON(),
      attemptCount: this.#attemptCount,
      nextAttemptAt: copyDate(this.#nextAttemptAt),
      deadlineAt: copyDate(this.#deadlineAt),
    };
  }

  private assertOpen(): void {
    if (this.#status !== 'PENDING' && this.#status !== 'PENDING_REFERENCE') {
      throw new InvalidTransactionStateError(`Transaction is already ${this.#status}`);
    }
  }

  private assertStatus(expected: WagerTransactionStatus): void {
    if (this.#status !== expected) {
      throw new InvalidTransactionStateError(`Transaction is ${this.#status}`);
    }
  }
}

function identity(props: CreateWagerTransactionProps) {
  return {
    id: props.id,
    providerId: props.providerId,
    externalTransactionId: props.externalTransactionId,
    idempotencyKey: props.idempotencyKey,
    walletId: props.walletId,
    playerId: props.playerId,
    roundId: props.roundId,
    gameId: props.gameId,
    kind: props.kind,
    createdAt: props.createdAt,
  };
}

function hashOf(props: CreateWagerTransactionProps, reference: string | undefined): string {
  return canonicalPayloadHash({
    providerId: props.providerId,
    externalTransactionId: props.externalTransactionId,
    playerId: props.playerId,
    walletId: props.walletId,
    roundId: props.roundId,
    gameId: props.gameId,
    kind: props.kind,
    money: props.money.toJSON(),
    referenceExternalTransactionId: reference,
  });
}

function assertExternalProvider(providerId: string): void {
  if (!PROVIDER_PATTERN.test(providerId) || providerId.startsWith('internal')) {
    throw new DomainError('INVALID_PAYLOAD', 'Provider id is not accepted on this edge');
  }
}

function assertIdempotencyKey(props: CreateWagerTransactionProps): void {
  if (props.idempotencyKey !== `${props.providerId}:${props.externalTransactionId}`) {
    throw new DomainError('INVALID_PAYLOAD', 'Idempotency key does not match the transaction pair');
  }
}

function readExternalReference(props: CreateWagerTransactionProps): string | undefined {
  if (props.referenceExternalTransactionId === null || props.referenceExternalTransactionId === '') {
    throw new DomainError('INVALID_PAYLOAD', 'Reference is empty');
  }
  const reference = props.referenceExternalTransactionId;
  if (props.kind === 'BET' || props.kind === 'LOSS') {
    if (reference !== undefined) {
      throw new DomainError('INVALID_PAYLOAD', 'Kind does not accept a reference');
    }
    return undefined;
  }
  if (props.kind === 'REFUND' || props.kind === 'ROLLBACK') {
    if (reference === undefined) {
      throw new DomainError('REFERENCE_REQUIRED', 'Reversal requires a reference');
    }
    return reference;
  }
  return reference;
}

function requireText(value: string): string {
  if (value.trim() === '' || value !== value.trim()) {
    throw new DomainError('INVALID_PAYLOAD', 'Transaction field is empty');
  }
  return value;
}

function copyDate(value: Date | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value.getTime());
}
