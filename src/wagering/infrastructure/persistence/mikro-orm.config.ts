import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migration20261126000001_core_schema } from './migrations/Migration20261126000001_core_schema';
import { Migration20261126000002_integrity_triggers } from './migrations/Migration20261126000002_integrity_triggers';
import { ALL_SCHEMAS } from './schemas';

export const MIGRATIONS = [
  { name: 'Migration20261126000001_core_schema', class: Migration20261126000001_core_schema },
  { name: 'Migration20261126000002_integrity_triggers', class: Migration20261126000002_integrity_triggers },
];

export function createOrmConfig(options: { url: string; poolMin?: number; poolMax?: number }): Options {
  return defineConfig({
    clientUrl: options.url,
    entities: ALL_SCHEMAS,
    // EntitySchema não precisa de reflection nem de varrer arquivos (funciona igual no Bun e num bundle).
    discovery: { disableDynamicFileAccess: true, warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
    pool: { min: options.poolMin ?? 2, max: options.poolMax ?? 20 },
    // O schema é das migrations; o ORM nunca altera ele.
    ensureDatabase: false,
    allowGlobalContext: false,
    forceUtcTimezone: true,
    debug: false,
  });
}
