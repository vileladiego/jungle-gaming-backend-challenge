import type { MikroORM } from '@mikro-orm/core';
import type { DependencyStatus } from '../health/health-report';

export async function probePostgres(orm: MikroORM): Promise<DependencyStatus> {
  try {
    const result = await orm.checkConnection();
    return result.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}
