import { Client } from 'pg';

let stopping = false;

async function main(): Promise<void> {
  const walletId = process.env.HOLD_WALLET_ID;
  const holdMs = Number(process.env.HOLD_MS ?? '0');
  const databaseUrl = process.env.DATABASE_URL;
  if (walletId === undefined || walletId === '' || databaseUrl === undefined || !Number.isInteger(holdMs) || holdMs < 1) {
    throw new Error('HOLD_WALLET_ID, HOLD_MS and DATABASE_URL are required');
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    await client.end().catch(() => undefined);
  };
  process.once('SIGTERM', () => {
    stopping = true;
    const stream = (client as { connection?: { stream?: { destroy: () => void } } }).connection?.stream;
    stream?.destroy();
    process.exit(0);
  });
  await client.query(`select set_config('lock_timeout', '10s', false)`);
  await client.query(`select set_config('statement_timeout', '0', false)`);
  await client.query('begin');
  const locked = await client.query(`select id from wallets where id = $1 for update`, [walletId]);
  if (locked.rowCount !== 1) {
    throw new Error('Wallet to lock was not found');
  }
  process.stdout.write(`${JSON.stringify({ holding: true, pid: process.pid })}\n`);
  await client.query(`select pg_sleep($1)`, [holdMs / 1000]);
  await client.query('commit');
  await release();
}

void main().catch((error: unknown) => {
  if (stopping) {
    process.exit(0);
  }
  process.stderr.write(`${error instanceof Error ? error.message : 'lock holder failed'}\n`);
  process.exit(1);
});
