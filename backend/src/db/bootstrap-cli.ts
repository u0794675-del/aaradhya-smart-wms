import process from 'node:process';
import { config } from '../config.ts';
import { openConfiguredDatabase } from './open.ts';
import { runMigrations } from './migrate.ts';
import { bootstrapSystem } from './bootstrap.ts';

const db = openConfiguredDatabase();
const applied = runMigrations(db);
console.log(`Database driver: ${db.dialect}`);
console.log(`Database: ${db.dialect === 'postgres' ? config.pgSchema : config.dbPath}`);
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Migrations already up to date');

if (!config.bootstrapPassword && process.env.BOOTSTRAP_PASSWORD === undefined) {
  console.log('BOOTSTRAP_PASSWORD not set; generating one-time passwords for newly created users.');
}

const result = bootstrapSystem(db, { password: config.bootstrapPassword || undefined });
console.log(`Warehouse ready: ${result.warehouseId}`);
console.log(`Locations: ${Object.keys(result.locations).join(', ')}`);
console.log(`Stock pools: ${Object.keys(result.pools).join(', ')}`);
if (result.createdUsers.length) {
  console.log('\nInitial user credentials (store securely; shown once):');
  for (const user of result.createdUsers) {
    console.log(`  ${user.role.padEnd(12)} ${user.email.padEnd(28)} ${user.password}`);
  }
} else {
  console.log('Users already exist; no credentials were changed.');
}
db.close();
