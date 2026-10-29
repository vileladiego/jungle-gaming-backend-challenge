import { Client } from 'pg';

const LOCK_KEY = 214203;

/**
 * Trava de sessão para os testes de integração não migrarem o mesmo Postgres ao mesmo tempo.
 * Não é lock de negócio. Cai quando a conexão fecha.
 */
export async function holdSchemaLock(): Promise<() => Promise<void>> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required for the schema lock');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  return async () => {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
    await client.end();
  };
}
