import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { openConfiguredDatabase } from '../src/db/open.ts';
import type { DB } from '../src/db/index.ts';

const OPERATIONAL_TABLES = [
  'packaging_consumptions',
  'package_lines',
  'packages',
  'return_lines',
  'returns',
  'shipments',
  'qc_inspections',
  'receipt_lines',
  'receipts',
  'purchase_order_lines',
  'purchase_orders',
  'order_lines',
  'reservations',
  'orders',
  'cycle_count_lines',
  'cycle_counts',
  'adjustment_requests',
  'transfer_lines',
  'transfers',
  'tasks',
  'notification_states',
  'notifications',
  'exceptions',
  'ai_action_logs',
  'idempotency_keys',
  'inventory_transactions',
  'inventory_balances',
  'box_content_declarations',
  'box_sources',
  'product_sources',
  'box_id_mappings',
  'workbook_source_rows',
  'import_jobs',
  'boxes',
  'batches',
  'product_aliases',
  'product_suppliers',
  'product_uom_conversions',
  'product_barcodes',
  'products',
  'vendors',
];

// Master data, access control, configuration, locations and packaging stay intact.
const KEPT_TABLES = [
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'settings',
  'warehouses',
  'locations',
  'stock_pools',
  'packaging_materials',
  'report_branding',
  'sequences',
  'sessions',
  'user_totp',
  'audit_events',
  'schema_migrations',
];

function count(db: DB, table: string): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return -1;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
}

const confirmed = process.argv.includes('--confirm');
const db = openConfiguredDatabase();
if (db.dialect !== 'sqlite') {
  console.error('This purge script is for the SQLite deployment only.');
  process.exit(1);
}

console.log('Current operational rows:');
for (const table of OPERATIONAL_TABLES) {
  const n = count(db, table);
  if (n > 0) console.log(`  ${String(n).padStart(6)}  ${table}`);
}
console.log('\nKept tables:', KEPT_TABLES.map((table) => `${table}(${count(db, table)})`).join(', '));

if (!confirmed) {
  console.log('\nDry run. Re-run with --confirm to delete the operational demo data after an automatic backup.');
  db.close();
  process.exit(0);
}

const backupDir = path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = path.join(backupDir, `wms-before-demo-purge-${stamp}.db`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
fs.copyFileSync(config.dbPath, backupPath);
console.log(`\nBackup written to ${backupPath}`);

db.exec('BEGIN IMMEDIATE');
try {
  // Break self-references before the bulk deletes.
  db.prepare('UPDATE products SET parent_id = NULL WHERE parent_id IS NOT NULL').run();
  db.prepare('UPDATE boxes SET parent_box_id = NULL WHERE parent_box_id IS NOT NULL').run();
  // The ledger is append-only at runtime. For this audited demo purge the delete
  // trigger is lifted for one transaction and recreated exactly as it was.
  const ledgerTrigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_txn_no_delete'")
    .get() as { sql: string } | undefined;
  if (ledgerTrigger) db.exec('DROP TRIGGER trg_txn_no_delete');
  // Reversal rows point at the original transaction, so remove them first.
  db.prepare('DELETE FROM inventory_transactions WHERE reversal_of IS NOT NULL').run();
  for (const table of OPERATIONAL_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    db.prepare(`DELETE FROM "${table}"`).run();
  }
  if (ledgerTrigger) db.exec(ledgerTrigger.sql);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log('\nRows after purge:');
let remaining = 0;
for (const table of OPERATIONAL_TABLES) {
  const n = count(db, table);
  if (n > 0) {
    remaining += n;
    console.log(`  ${String(n).padStart(6)}  ${table}`);
  }
}
if (remaining === 0) console.log('  all operational tables are empty');
for (const table of ['users', 'settings', 'locations', 'stock_pools', 'packaging_materials']) {
  console.log(`  kept ${table}: ${count(db, table)}`);
}
db.close();
