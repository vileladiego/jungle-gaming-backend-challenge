import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { requireEnv } from '../config/env';
import {
  InboxMessageRecord,
  IngressRejectRecord,
  OutboxMessageRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
  WagerTransactionRecord,
} from './records';

const entities = [
  WalletRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
  IngressRejectRecord,
];

function configFor(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities,
    discovery: { warnWhenNoEntities: false },
    debug: false,
    extensions: [Migrator],
    migrations: {
      path: 'dist/persistence/migrations',
      pathTs: 'src/persistence/migrations',
      snapshot: false,
      allOrNothing: false,
    },
  });
}

/** Dono do schema. Usado só pelo CLI de migration. */
export function buildMigrationMikroOrmConfig() {
  return configFor(requireEnv('DATABASE_URL'));
}

/** Runtime. Não é dono das tabelas e não tem TRUNCATE. */
export function buildRuntimeMikroOrmConfig() {
  return configFor(requireEnv('DATABASE_APP_URL'));
}

export function buildMikroOrmConfig() {
  return buildMigrationMikroOrmConfig();
}

export default buildMigrationMikroOrmConfig();
