import type { DB } from '../db/index.ts';

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function listSettings(db: DB): Array<{ key: string; value: unknown; description: string | null; updated_at: string | null }> {
  return db
    .prepare('SELECT key, value_json, description, updated_at FROM settings ORDER BY key')
    .all()
    .map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.value_json)),
      description: row.description === null ? null : String(row.description),
      updated_at: row.updated_at === null ? null : String(row.updated_at),
    }));
}
