import { config } from '../config.ts';
import { openDatabase, type DB } from './index.ts';
import { openPostgresDatabase } from './postgres/index.ts';

export function openConfiguredDatabase(): DB {
  if (config.dbDriver === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    }
    return openPostgresDatabase({
      connectionString: config.databaseUrl,
      schema: config.pgSchema,
    });
  }
  if (config.dbDriver !== 'sqlite') {
    throw new Error(`Unsupported DB_DRIVER "${config.dbDriver}"; expected sqlite or postgres`);
  }
  return openDatabase(config.dbPath);
}
