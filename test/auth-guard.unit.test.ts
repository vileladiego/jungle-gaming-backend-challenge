import { describe, expect, test } from 'bun:test';
import { AuthGuard } from '../src/application/auth.guard';

describe('AuthGuard', () => {
  test('permite a requisição e não consulta credencial', () => {
    expect(new AuthGuard().canActivate()).toBe(true);
  });
});
