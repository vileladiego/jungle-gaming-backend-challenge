export type DependencyStatus = 'up' | 'down';

export interface LiveReport {
  readonly status: 'ok';
}

export interface ReadyReport {
  readonly status: 'ok' | 'unavailable';
  readonly postgres: DependencyStatus;
  readonly sqs: DependencyStatus;
}
