import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

export type BulkEntity = 'products' | 'boxes' | 'import_jobs';

export interface BulkDeleteResult {
  deleted: string[];
  skipped: Array<{ id: string; reason: string }>;
}

// Rows that only describe the record itself. They are removed together with a
// deletable record, never on their own, and never while deletion is blocked.
const DEPENDENT_TABLES: Record<BulkEntity, string[]> = {
  products: ['product_barcodes', 'product_uom_conversions', 'product_aliases', 'product_suppliers', 'product_sources'],
  boxes: ['box_sources'],
  import_jobs: [],
};

const ENTITY_TYPE: Record<BulkEntity, string> = {
  products: 'PRODUCT',
  boxes: 'BOX',
  import_jobs: 'IMPORT_JOB',
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableExists(db: DB, name: string): boolean {
  if (db.dialect === 'postgres') {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name = ?`,
        )
        .get(name),
    );
  }
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function foreignKeys(db: DB, table: string): Array<{ table: string; from: string }> {
  if (!tableExists(db, table)) return [];
  if (db.dialect === 'postgres') {
    return db
      .prepare(
        `SELECT kcu.column_name AS "from", ccu.table_name AS "table"
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = current_schema()
            AND tc.table_name = ?`,
      )
      .all(table) as Array<{ table: string; from: string }>;
  }
  return db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as Array<{ table: string; from: string }>;
}

function listTables(db: DB): Array<{ name: string }> {
  if (db.dialect === 'postgres') {
    return db
      .prepare(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      )
      .all() as Array<{ name: string }>;
  }
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
}

function referencesFrom(db: DB, table: BulkEntity, id: string, ignore: Set<string>): Array<{ table: string; count: number }> {
  const found: Array<{ table: string; count: number }> = [];
  for (const { name } of listTables(db)) {
    if (ignore.has(name)) continue;
    const columns = [...new Set(foreignKeys(db, name).filter((fk) => fk.table === table).map((fk) => fk.from))];
    for (const column of columns) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)} WHERE ${quoteIdent(column)} = ?`)
        .get(id) as { n: number };
      if (Number(row.n) > 0) found.push({ table: name, count: Number(row.n) });
    }
  }
  return found;
}

function deleteDependents(db: DB, table: BulkEntity, id: string): void {
  for (const child of DEPENDENT_TABLES[table]) {
    for (const fk of foreignKeys(db, child).filter((entry) => entry.table === table)) {
      db.prepare(`DELETE FROM ${quoteIdent(child)} WHERE ${quoteIdent(fk.from)} = ?`).run(id);
    }
  }
}

export function bulkDelete(
  db: DB,
  entity: BulkEntity,
  rawIds: string[],
  actor: AuthUser,
  reason = 'Bulk delete from register',
): BulkDeleteResult {
  const ids = [...new Set(rawIds.map((value) => value.trim()).filter(Boolean))];
  const result: BulkDeleteResult = { deleted: [], skipped: [] };
  if (ids.length === 0) return result;

  const ignore = new Set(DEPENDENT_TABLES[entity]);
  const before: unknown[] = [];

  withTransaction(db, () => {
    for (const id of ids) {
      const row = db.prepare(`SELECT * FROM ${quoteIdent(entity)} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) {
        result.skipped.push({ id, reason: 'Record not found' });
        continue;
      }
      const blockers = referencesFrom(db, entity, id, ignore);
      if (blockers.length > 0) {
        const linked = blockers.map((entry) => `${entry.table} (${entry.count})`).join(', ');
        result.skipped.push({ id, reason: `Linked to ${linked}; remove those records first` });
        continue;
      }
      deleteDependents(db, entity, id);
      db.prepare(`DELETE FROM ${quoteIdent(entity)} WHERE id = ?`).run(id);
      result.deleted.push(id);
      before.push(row);
    }

    if (result.deleted.length > 0) {
      recordAudit(db, {
        eventType: `${ENTITY_TYPE[entity]}_BULK_DELETED`,
        entityType: ENTITY_TYPE[entity],
        reason,
        before: { rows: before },
        after: { deletedCount: result.deleted.length, skippedCount: result.skipped.length },
        refs: { ids: result.deleted, skipped: result.skipped },
        actor: { userId: actor.id, role: actor.role },
      });
    }
  });

  return result;
}
