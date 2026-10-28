import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './index.ts';
import { nowIso } from '../lib/time.ts';

const migrationsRoot = path.resolve(import.meta.dirname, 'migrations');

export function runMigrations(db: DB): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => String(r.version)),
  );
  const migrationsDir = db.dialect === 'postgres' ? path.join(migrationsRoot, 'postgres') : migrationsRoot;
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, nowIso());
      db.exec('COMMIT');
      newlyApplied.push(file);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return newlyApplied;
}
