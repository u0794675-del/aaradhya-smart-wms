import { createHash } from 'node:crypto';
import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import { conflict, isConstraintViolation } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';

export interface IdempotencyMeta {
  userId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

interface StoredRow {
  request_hash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status: number | null;
  response_json: string | null;
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/**
 * Executes a stock-changing operation exactly once per (user, idempotency key).
 * The key row, business mutation and stored response commit atomically.
 */
export function runIdempotent<T>(
  db: DB,
  meta: IdempotencyMeta,
  work: () => T,
): { data: T; replayed: boolean } {
  try {
    return withTransaction(db, () => {
      const existing = db
        .prepare(
          'SELECT request_hash, status, response_status, response_json FROM idempotency_keys WHERE user_id = ? AND idem_key = ?',
        )
        .get(meta.userId, meta.key) as StoredRow | undefined;

      if (existing) {
        if (existing.request_hash !== meta.requestHash) {
          throw conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was already used with a different request payload',
          );
        }
        if (existing.status !== 'COMPLETED' || !existing.response_json) {
          throw conflict('REQUEST_IN_PROGRESS', 'An identical request is already being processed');
        }
        return { data: JSON.parse(existing.response_json) as T, replayed: true };
      }

      db.prepare(
        `INSERT INTO idempotency_keys
          (user_id, idem_key, method, path, request_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', ?)`,
      ).run(meta.userId, meta.key, meta.method, meta.path, meta.requestHash, nowIso());

      const data = work();
      db.prepare(
        `UPDATE idempotency_keys
            SET status = 'COMPLETED', response_status = 200, response_json = ?, completed_at = ?
          WHERE user_id = ? AND idem_key = ?`,
      ).run(JSON.stringify(data), nowIso(), meta.userId, meta.key);
      return { data, replayed: false };
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    if (isConstraintViolation(error)) {
      const row = db
        .prepare('SELECT request_hash, status, response_status, response_json FROM idempotency_keys WHERE user_id = ? AND idem_key = ?')
        .get(meta.userId, meta.key) as StoredRow | undefined;
      if (row) {
        if (row.request_hash !== meta.requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request payload');
        }
        if (row.status === 'COMPLETED' && row.response_json) {
          return { data: JSON.parse(row.response_json) as T, replayed: true };
        }
      }
      throw conflict('REQUEST_IN_PROGRESS', 'An identical request is already being processed');
    }
    throw error;
  }
}
