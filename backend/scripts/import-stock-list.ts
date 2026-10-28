import fs from 'node:fs';
import path from 'node:path';
import { openConfiguredDatabase } from '../src/db/open.ts';
import { importStockList } from '../src/services/stock-list-import.ts';
import type { AuthUser } from '../src/services/auth.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
if (!filePath) {
  console.error('Usage: tsx scripts/import-stock-list.ts <file.xlsx> [--brand Allen] [--zone "Zone B"] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const db = openConfiguredDatabase();
const row = db
  .prepare(
    `SELECT u.id, u.employee_code, u.name, u.email, u.role_code
       FROM users u JOIN roles r ON r.code = u.role_code
      WHERE r.code = 'ADMIN' ORDER BY u.created_at LIMIT 1`,
  )
  .get() as Record<string, string> | undefined;
if (!row) {
  console.error('No ADMIN user found; bootstrap the system first.');
  process.exit(1);
}
const actor: AuthUser = {
  id: row.id,
  employeeCode: row.employee_code,
  name: row.name,
  email: row.email,
  role: row.role_code,
  permissions: ['*'],
};

const fileName = path.basename(filePath);
const result = await importStockList(
  db,
  {
    fileName,
    contentBase64: fs.readFileSync(filePath).toString('base64'),
    brand: arg('brand'),
    zone: arg('zone'),
  },
  actor,
  { dryRun: process.argv.includes('--dry-run') },
);

console.log(
  JSON.stringify(
    {
      committed: result.committed,
      job: { id: result.job.id, status: result.job.status },
      source: result.summary.source,
      totals: result.summary.totals,
      duplicates: result.summary.duplicates,
      reconciliation: result.reconciliation,
      warnings: result.issues.filter((entry) => entry.severity === 'WARNING').slice(0, 10),
    },
    null,
    2,
  ),
);
db.close();
