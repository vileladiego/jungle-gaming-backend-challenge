import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { requireEnv } from '../config/env';

export function buildMikroOrmConfig() {
  return defineConfig({
    clientUrl: requireEnv('DATABASE_URL'),
    entities: [],
    discovery: { warnWhenNoEntities: false },
    debug: false,
    extensions: [Migrator],
    migrations: {
      path: 'dist/persistence/migrations',
      pathTs: 'src/persistence/migrations',
      snapshot: false,
    },
  });
}

export default buildMikroOrmConfig();
