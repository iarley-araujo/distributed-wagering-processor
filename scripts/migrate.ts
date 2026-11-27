import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/config/app-config';
import { createOrmConfig } from '../src/wagering/infrastructure/persistence/mikro-orm.config';

/** Uso: bun run scripts/migrate.ts up|down|status [--to <nome>] [--all] */
const [command = 'up', ...rest] = process.argv.slice(2);
const config = loadConfig();
const orm = await MikroORM.init(createOrmConfig({ url: config.database.url, poolMin: 0, poolMax: 2 }));
const migrator = orm.getMigrator();

try {
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(JSON.stringify({ command, applied: applied.map((m) => m.name) }));
  } else if (command === 'down') {
    const all = rest.includes('--all');
    const reverted = all ? await migrator.down({ to: 0 }) : await migrator.down();
    console.log(JSON.stringify({ command, reverted: reverted.map((m) => m.name) }));
  } else if (command === 'status') {
    const executed = await migrator.getExecutedMigrations();
    const pending = await migrator.getPendingMigrations();
    console.log(JSON.stringify({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }));
  } else {
    throw new Error(`Unknown command ${command}`);
  }
} finally {
  await orm.close(true);
}
