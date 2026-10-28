import type { DB } from '../db/index.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';

export interface AuditActor {
  userId?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface AuditEntry {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE';
  transactionId?: string | null;
  refs?: unknown;
  actor?: AuditActor;
}

export function recordAudit(db: DB, entry: AuditEntry): string {
  const id = newId();
  db.prepare(
    `INSERT INTO audit_events
      (id, event_type, entity_type, entity_id, actor_user_id, actor_role, correlation_id,
       transaction_id, before_json, after_json, reason, outcome, refs_json, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.eventType,
    entry.entityType,
    entry.entityId ?? null,
    entry.actor?.userId ?? null,
    entry.actor?.role ?? null,
    entry.actor?.correlationId ?? null,
    entry.transactionId ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.reason ?? null,
    entry.outcome ?? 'SUCCESS',
    entry.refs === undefined ? null : JSON.stringify(entry.refs),
    entry.actor?.ip ?? null,
    entry.actor?.userAgent ?? null,
    nowIso(),
  );
  return id;
}
