import type { DB } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

export function updateSetting(db: DB, key: string, value: unknown, actor: AuthUser) {
  const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as
    | { key: string; value_json: string; description: string | null }
    | undefined;
  if (!row) throw notFound(`Setting '${key}' does not exist`);
  const before = JSON.parse(row.value_json) as unknown;
  const beforeType = before === null ? 'null' : typeof before;
  const nextType = value === null ? 'null' : typeof value;
  if (beforeType !== nextType || !['string', 'number', 'boolean'].includes(nextType)) {
    throw badRequest(
      'SETTING_TYPE_MISMATCH',
      `Setting '${key}' expects a ${beforeType} value, received ${nextType}`,
    );
  }
  if (nextType === 'number' && (!Number.isFinite(value as number) || (value as number) < 0)) {
    throw badRequest('SETTING_VALUE_INVALID', 'Numeric settings must be finite, non-negative numbers');
  }
  if (nextType === 'string' && !(value as string).trim()) {
    throw badRequest('SETTING_VALUE_INVALID', 'Text settings cannot be empty');
  }
  db.prepare('UPDATE settings SET value_json = ?, updated_by = ?, updated_at = ? WHERE key = ?').run(
    JSON.stringify(value),
    actor.id,
    nowIso(),
    key,
  );
  recordAudit(db, {
    eventType: 'SETTING_UPDATED',
    entityType: 'SETTING',
    entityId: key,
    before: { value: before },
    after: { value },
    actor: { userId: actor.id, role: actor.role },
  });
  return { key, value, description: row.description };
}
