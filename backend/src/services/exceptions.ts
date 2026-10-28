import type { DB } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { documentNo, newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
const TRANSITIONS: Record<string, string[]> = {
  OPEN: ['INVESTIGATING', 'RESOLVED', 'CLOSED'],
  INVESTIGATING: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

export interface CreateExceptionInput {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  entityType?: string | null;
  entityId?: string | null;
  description: string;
  ownerUserId?: string | null;
}

export function listExceptions(
  db: DB,
  filters: { status?: string; severity?: string; type?: string; search?: string; limit?: number; offset?: number },
) {
  const conditions = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    conditions.push(`e.status IN (${filters.status.split(',').map(() => '?').join(',')})`);
    params.push(...filters.status.split(',').map((s) => s.trim()));
  }
  if (filters.severity) {
    conditions.push('e.severity = ?');
    params.push(filters.severity);
  }
  if (filters.type) {
    conditions.push('e.type = ?');
    params.push(filters.type);
  }
  if (filters.search) {
    conditions.push('(e.exception_no LIKE ? OR e.description LIKE ? OR e.entity_id LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT e.*, u.name AS owner_name, c.name AS created_by_name
         FROM exceptions e
         LEFT JOIN users u ON u.id = e.owner_user_id
         LEFT JOIN users c ON c.id = e.created_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE e.status WHEN 'OPEN' THEN 0 WHEN 'INVESTIGATING' THEN 1 WHEN 'RESOLVED' THEN 2 ELSE 3 END,
                 CASE e.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
                 e.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM exceptions e WHERE ${conditions.join(' AND ')}`)
    .get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}

export function getException(db: DB, id: string) {
  const row = db
    .prepare(
      `SELECT e.*, u.name AS owner_name, c.name AS created_by_name
         FROM exceptions e
         LEFT JOIN users u ON u.id = e.owner_user_id
         LEFT JOIN users c ON c.id = e.created_by
        WHERE e.id = ? OR e.exception_no = ?`,
    )
    .get(id, id.toUpperCase()) as Record<string, any> | undefined;
  if (!row) throw notFound('Exception not found');
  const audit = db
    .prepare(
      `SELECT a.id, a.event_type, a.reason, a.outcome, a.created_at, u.name AS actor_name
         FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.entity_id = ? ORDER BY a.created_at DESC LIMIT 100`,
    )
    .all(row.id);
  return { ...row, audit };
}

export function createException(db: DB, input: CreateExceptionInput, actor: AuthUser) {
  if (!SEVERITIES.includes(input.severity)) throw badRequest('INVALID_SEVERITY', 'Unknown exception severity');
  if (!input.type.trim()) throw badRequest('EXCEPTION_TYPE_REQUIRED', 'An exception type is required');
  if (!input.description.trim()) throw badRequest('EXCEPTION_DESCRIPTION_REQUIRED', 'A description is required');
  if (input.ownerUserId) {
    const owner = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(input.ownerUserId);
    if (!owner) throw badRequest('OWNER_NOT_FOUND', 'Owner user was not found or is inactive');
  }
  const id = newId();
  const exceptionNo = documentNo(db, 'EXCEPTION', 'EXC', 6);
  db.prepare(
    `INSERT INTO exceptions
      (id, exception_no, type, severity, status, owner_user_id, entity_type, entity_id, description, created_by, created_at)
     VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    exceptionNo,
    input.type.trim().toUpperCase(),
    input.severity,
    input.ownerUserId ?? actor.id,
    input.entityType ?? null,
    input.entityId ?? null,
    input.description.trim(),
    actor.id,
    nowIso(),
  );
  recordAudit(db, {
    eventType: 'EXCEPTION_RAISED',
    entityType: 'EXCEPTION',
    entityId: id,
    after: { exceptionNo, type: input.type, severity: input.severity, entityType: input.entityType ?? null },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, exceptionNo, status: 'OPEN' };
}

export function updateException(
  db: DB,
  id: string,
  input: { status?: string; resolution?: string | null; ownerUserId?: string | null; severity?: string },
  actor: AuthUser,
) {
  const current = db.prepare('SELECT * FROM exceptions WHERE id = ? OR exception_no = ?').get(id, id.toUpperCase()) as
    | Record<string, any>
    | undefined;
  if (!current) throw notFound('Exception not found');
  if (input.severity && !SEVERITIES.includes(input.severity as any)) {
    throw badRequest('INVALID_SEVERITY', 'Unknown exception severity');
  }
  const nextStatus = input.status ?? current.status;
  if (!STATUSES.includes(nextStatus as any)) throw badRequest('INVALID_STATUS', 'Unknown exception status');
  if (nextStatus !== current.status && !TRANSITIONS[current.status]?.includes(nextStatus)) {
    throw conflict('INVALID_EXCEPTION_TRANSITION', `Exception cannot move from ${current.status} to ${nextStatus}`);
  }
  const resolution = input.resolution !== undefined ? input.resolution : current.resolution;
  if (['RESOLVED', 'CLOSED'].includes(nextStatus) && !resolution) {
    throw badRequest('RESOLUTION_REQUIRED', 'A resolution note is required to resolve or close an exception');
  }
  if (input.ownerUserId) {
    const owner = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(input.ownerUserId);
    if (!owner) throw badRequest('OWNER_NOT_FOUND', 'Owner user was not found or is inactive');
  }
  const resolvedAt = ['RESOLVED', 'CLOSED'].includes(nextStatus) ? (current.resolved_at ?? nowIso()) : null;
  db.prepare(
    `UPDATE exceptions
        SET status = ?, severity = ?, owner_user_id = ?, resolution = ?, resolved_at = ?
      WHERE id = ?`,
  ).run(
    nextStatus,
    input.severity ?? current.severity,
    input.ownerUserId ?? current.owner_user_id,
    resolution ?? null,
    resolvedAt,
    current.id,
  );
  recordAudit(db, {
    eventType: 'EXCEPTION_UPDATED',
    entityType: 'EXCEPTION',
    entityId: current.id,
    before: { status: current.status, severity: current.severity, ownerUserId: current.owner_user_id },
    after: { status: nextStatus, severity: input.severity ?? current.severity, resolution: resolution ?? null },
    reason: resolution ?? null,
    actor: { userId: actor.id, role: actor.role },
  });
  return getException(db, current.id);
}
