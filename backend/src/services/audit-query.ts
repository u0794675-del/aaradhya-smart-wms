import type { DB } from '../db/index.ts';

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function listAudit(
  db: DB,
  filters: {
    eventType?: string;
    entityType?: string;
    entityId?: string;
    actorUserId?: string;
    transactionId?: string;
    outcome?: 'SUCCESS' | 'FAILURE';
    search?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  },
) {
  const conditions = ['1=1'];
  const params: any[] = [];
  if (filters.eventType) {
    conditions.push('a.event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.entityType) {
    conditions.push('a.entity_type = ?');
    params.push(filters.entityType);
  }
  if (filters.entityId) {
    conditions.push('a.entity_id = ?');
    params.push(filters.entityId);
  }
  if (filters.actorUserId) {
    conditions.push('a.actor_user_id = ?');
    params.push(filters.actorUserId);
  }
  if (filters.transactionId) {
    conditions.push('a.transaction_id = ?');
    params.push(filters.transactionId);
  }
  if (filters.outcome) {
    conditions.push('a.outcome = ?');
    params.push(filters.outcome);
  }
  if (filters.search) {
    conditions.push('(a.event_type LIKE ? OR a.reason LIKE ? OR u.name LIKE ? OR a.entity_id LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }
  if (filters.from) {
    conditions.push('a.created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('a.created_at <= ?');
    params.push(filters.to);
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS actor_name, u.email AS actor_email
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map((row) => ({
      ...row,
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      refs: parseJson(row.refs_json),
    }));
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${conditions.join(' AND ')}`)
    .get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}
