import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config.ts';
import { openDatabase, type DB } from '../src/db/index.ts';
import { openPostgresDatabase } from '../src/db/postgres/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { bootstrapSystem } from '../src/db/bootstrap.ts';
import { parseWorkbook } from '../src/lib/workbook.ts';
import { analyzeWorkbook, importAnalyzedWorkbook } from '../src/services/workbook-import.ts';
import type { AuthUser } from '../src/services/auth.ts';

function openDb(): DB {
  if (config.dbDriver === 'postgres') {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    return openPostgresDatabase({ connectionString: config.databaseUrl, schema: config.pgSchema });
  }
  return openDatabase(config.dbPath);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import:workbook -- <workbook.xlsx> [--dry-run]');
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`Workbook not found: ${absolute}`);
  const dryRun = process.argv.includes('--dry-run');
  const buffer = fs.readFileSync(absolute);
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Workbook exceeds the 8 MB import limit');

  const db = openDb();
  try {
    runMigrations(db);
    const admin = db
      .prepare("SELECT id, employee_code, name, email, role_code FROM users WHERE role_code = 'ADMIN' AND is_active = 1 ORDER BY created_at LIMIT 1")
      .get() as
      | { id: string; employee_code: string; name: string; email: string; role_code: string }
      | undefined;
    if (!admin) {
      if (!config.bootstrapPassword) {
        throw new Error('No administrator exists. Set BOOTSTRAP_PASSWORD to initialize this database first.');
      }
      bootstrapSystem(db, { password: config.bootstrapPassword });
    }
    const actorRow = db
      .prepare("SELECT id, employee_code, name, email, role_code FROM users WHERE role_code = 'ADMIN' AND is_active = 1 ORDER BY created_at LIMIT 1")
      .get() as { id: string; employee_code: string; name: string; email: string; role_code: string };
    const actor: AuthUser = {
      id: actorRow.id,
      employeeCode: actorRow.employee_code,
      name: actorRow.name,
      email: actorRow.email,
      role: actorRow.role_code,
      permissions: ['*'],
    };

    const parsed = await parseWorkbook(buffer);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const plan = analyzeWorkbook(parsed, path.basename(absolute), hash);
    const result = importAnalyzedWorkbook(db, plan, actor, dryRun);
    const payload = {
      mode: dryRun ? 'DRY_RUN' : 'COMMIT',
      committed: result.committed,
      jobId: result.job.id,
      status: result.job.status,
      summary: result.summary,
      reconciliation: result.reconciliation ?? null,
      errors: result.issues.filter((entry) => entry.severity === 'ERROR').slice(0, 50),
      warnings: result.issues.filter((entry) => entry.severity === 'WARNING').slice(0, 50),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    const errors = result.issues.filter((entry) => entry.severity === 'ERROR').length;
    if (errors > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Workbook import failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
