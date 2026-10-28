import type { DB } from '../db/index.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { getSetting } from '../lib/settings.ts';
import { addDays, nowIso, todayIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

function insertNotification(
  db: DB,
  input: {
    ruleCode: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    title: string;
    body: string;
    entityType: string;
    entityId: string;
    assignedRole: string | null;
    dedupeKey: string;
  },
): boolean {
  const result = db
    .prepare(
      `INSERT INTO notifications
        (id, rule_code, severity, title, body, entity_type, entity_id, assigned_role, status, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      newId(),
      input.ruleCode,
      input.severity,
      input.title,
      input.body,
      input.entityType,
      input.entityId,
      input.assignedRole,
      nowIso(),
      input.dedupeKey,
    );
  return Number(result.changes) === 1;
}

function activateCondition(db: DB, dedupeKey: string): boolean {
  const row = db.prepare('SELECT active FROM notification_states WHERE dedupe_key = ?').get(dedupeKey) as
    | { active: number }
    | undefined;
  if (row?.active === 1) return false;
  db.prepare(
    `INSERT INTO notification_states (dedupe_key, active, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET active = 1, updated_at = excluded.updated_at`,
  ).run(dedupeKey, nowIso());
  return true;
}

function deactivateCleared(db: DB, ruleCode: string, activeKeys: Set<string>) {
  const rows = db
    .prepare("SELECT dedupe_key FROM notification_states WHERE active = 1 AND dedupe_key LIKE ?")
    .all(`${ruleCode}:%`) as Array<{ dedupe_key: string }>;
  for (const row of rows) {
    if (activeKeys.has(row.dedupe_key)) continue;
    db.prepare('UPDATE notification_states SET active = 0, updated_at = ? WHERE dedupe_key = ?').run(
      nowIso(),
      row.dedupe_key,
    );
  }
}

function resolveStale(db: DB, notificationId: string, reason: string): boolean {
  const result = db
    .prepare(
      "UPDATE notifications SET status = 'RESOLVED', resolved_at = ? WHERE id = ? AND status IN ('OPEN','ACKNOWLEDGED')",
    )
    .run(nowIso(), notificationId);
  if (Number(result.changes) === 1) {
    recordAudit(db, {
      eventType: 'NOTIFICATION_AUTO_RESOLVED',
      entityType: 'NOTIFICATION',
      entityId: notificationId,
      reason,
    });
    return true;
  }
  return false;
}

export function refreshNotifications(db: DB): { created: number; resolved: number } {
  let created = 0;
  let resolved = 0;
  const thresholdDefault = getSetting(db, 'low_stock_default', 20);
  const warningDays = getSetting(db, 'expiry_warning_days', 60);

  const lowStock = db
    .prepare(
      `SELECT * FROM (
         SELECT p.id, p.sku, p.name, COALESCE(p.low_stock_threshold, ?) AS threshold,
                COALESCE(SUM(CASE WHEN ib.status = 'AVAILABLE'
                                  THEN ib.quantity - ib.reserved_quantity ELSE 0 END), 0) AS available
           FROM products p
           LEFT JOIN inventory_balances ib ON ib.product_id = p.id
          WHERE p.status = 'ACTIVE'
          GROUP BY p.id
       ) s
        WHERE s.available < s.threshold`,
    )
    .all(thresholdDefault) as Array<Record<string, any>>;
  const lowStockIds = new Set(lowStock.map((row) => String(row.id)));
  for (const row of lowStock) {
    const dedupeKey = `LOW_STOCK:${row.id}`;
    if (!activateCondition(db, dedupeKey)) continue;
    const available = Number(row.available);
    const threshold = Number(row.threshold);
    if (
      insertNotification(db, {
        ruleCode: 'LOW_STOCK',
        severity: available <= 0 ? 'CRITICAL' : 'WARNING',
        title: `Low stock: ${row.sku}`,
        body: `${row.name} has ${available} available against a threshold of ${threshold}.`,
        entityType: 'PRODUCT',
        entityId: String(row.id),
        assignedRole: 'MANAGER',
        dedupeKey,
      })
    ) {
      created += 1;
    }
  }
  const openLow = db
    .prepare("SELECT id, entity_id FROM notifications WHERE rule_code = 'LOW_STOCK' AND status IN ('OPEN','ACKNOWLEDGED')")
    .all() as Array<{ id: string; entity_id: string | null }>;
  for (const notification of openLow) {
    if (!notification.entity_id || !lowStockIds.has(notification.entity_id)) {
      if (resolveStale(db, notification.id, 'Stock is no longer below its low-stock threshold')) resolved += 1;
    }
  }
  deactivateCleared(db, 'LOW_STOCK', new Set([...lowStockIds].map((id) => `LOW_STOCK:${id}`)));

  const expiring = db
    .prepare(
      `SELECT b.id, b.batch_no, b.expiry_date, p.sku, p.name, SUM(ib.quantity) AS quantity
         FROM batches b
         JOIN products p ON p.id = b.product_id
         JOIN inventory_balances ib ON ib.batch_id = b.id
        WHERE ib.quantity > 0 AND ib.status = 'AVAILABLE' AND b.expiry_date IS NOT NULL
          AND b.expiry_date <= ?
        GROUP BY b.id, p.id`,
    )
    .all(addDays(warningDays).slice(0, 10)) as Array<Record<string, any>>;
  const expiringIds = new Set(expiring.map((row) => String(row.id)));
  for (const row of expiring) {
    const dedupeKey = `BATCH_EXPIRY:${row.id}`;
    if (!activateCondition(db, dedupeKey)) continue;
    const expired = String(row.expiry_date) < todayIso();
    if (
      insertNotification(db, {
        ruleCode: 'BATCH_EXPIRY',
        severity: expired ? 'CRITICAL' : 'WARNING',
        title: `${expired ? 'Expired' : 'Expiring'} batch ${row.batch_no}`,
        body: `${row.sku} · ${row.name} has ${Number(row.quantity)} units ${expired ? 'expired' : 'expiring'} on ${row.expiry_date}.`,
        entityType: 'BATCH',
        entityId: String(row.id),
        assignedRole: 'MANAGER',
        dedupeKey,
      })
    ) {
      created += 1;
    }
  }
  const openExpiry = db
    .prepare("SELECT id, entity_id FROM notifications WHERE rule_code = 'BATCH_EXPIRY' AND status IN ('OPEN','ACKNOWLEDGED')")
    .all() as Array<{ id: string; entity_id: string | null }>;
  for (const notification of openExpiry) {
    if (!notification.entity_id || !expiringIds.has(notification.entity_id)) {
      if (resolveStale(db, notification.id, 'Batch is no longer expiring or has no sellable stock')) resolved += 1;
    }
  }
  deactivateCleared(db, 'BATCH_EXPIRY', new Set([...expiringIds].map((id) => `BATCH_EXPIRY:${id}`)));

  const criticalExceptions = db
    .prepare(
      `SELECT id, exception_no, description FROM exceptions
        WHERE status IN ('OPEN','INVESTIGATING') AND severity = 'CRITICAL'`,
    )
    .all() as Array<Record<string, any>>;
  for (const row of criticalExceptions) {
    const dedupeKey = `CRITICAL_EXCEPTION:${row.id}`;
    if (!activateCondition(db, dedupeKey)) continue;
    if (
      insertNotification(db, {
        ruleCode: 'CRITICAL_EXCEPTION',
        severity: 'CRITICAL',
        title: `Critical exception ${row.exception_no}`,
        body: String(row.description),
        entityType: 'EXCEPTION',
        entityId: String(row.id),
        assignedRole: 'MANAGER',
        dedupeKey,
      })
    ) {
      created += 1;
    }
  }
  const openCritical = db
    .prepare(
      "SELECT id, entity_id FROM notifications WHERE rule_code = 'CRITICAL_EXCEPTION' AND status IN ('OPEN','ACKNOWLEDGED')",
    )
    .all() as Array<{ id: string; entity_id: string | null }>;
  for (const notification of openCritical) {
    const active = notification.entity_id
      ? db
          .prepare(
            `SELECT id FROM exceptions WHERE id = ? AND status IN ('OPEN','INVESTIGATING') AND severity = 'CRITICAL'`,
          )
          .get(notification.entity_id)
      : undefined;
    if (!active && resolveStale(db, notification.id, 'Exception is no longer open and critical')) resolved += 1;
  }
  deactivateCleared(
    db,
    'CRITICAL_EXCEPTION',
    new Set(criticalExceptions.map((row) => `CRITICAL_EXCEPTION:${row.id}`)),
  );

  return { created, resolved };
}

export function listNotifications(db: DB, filters: { status?: string; limit?: number }) {
  refreshNotifications(db);
  const limit = Math.min(filters.limit ?? 100, 300);
  const rows = filters.status
    ? db
        .prepare(
          `SELECT n.*, u.name AS acknowledged_by_name FROM notifications n
             LEFT JOIN users u ON u.id = n.acknowledged_by
            WHERE n.status = ? ORDER BY CASE n.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                    n.created_at DESC LIMIT ?`,
        )
        .all(filters.status, limit)
    : db
        .prepare(
          `SELECT n.*, u.name AS acknowledged_by_name FROM notifications n
             LEFT JOIN users u ON u.id = n.acknowledged_by
            ORDER BY CASE n.status WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END,
                     CASE n.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                     n.created_at DESC LIMIT ?`,
        )
        .all(limit);
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM notifications GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row.status] = Number(row.n);
  return { rows, counts: byStatus };
}

export function acknowledgeNotification(db: DB, id: string, actor: AuthUser) {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!row) throw notFound('Notification not found');
  if (row.status !== 'OPEN') throw conflict('INVALID_NOTIFICATION_TRANSITION', `Notification is ${row.status}`);
  db.prepare("UPDATE notifications SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?").run(
    actor.id,
    nowIso(),
    id,
  );
  recordAudit(db, {
    eventType: 'NOTIFICATION_ACKNOWLEDGED',
    entityType: 'NOTIFICATION',
    entityId: id,
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, status: 'ACKNOWLEDGED' };
}

export function resolveNotification(db: DB, id: string, actor: AuthUser, reason: string) {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!row) throw notFound('Notification not found');
  if (!['OPEN', 'ACKNOWLEDGED'].includes(row.status)) {
    throw conflict('INVALID_NOTIFICATION_TRANSITION', `Notification is ${row.status}`);
  }
  db.prepare("UPDATE notifications SET status = 'RESOLVED', resolved_at = ?, acknowledged_by = ?, acknowledged_at = ? WHERE id = ?").run(
    nowIso(),
    actor.id,
    row.acknowledged_at ?? nowIso(),
    id,
  );
  recordAudit(db, {
    eventType: 'NOTIFICATION_RESOLVED',
    entityType: 'NOTIFICATION',
    entityId: id,
    reason,
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, status: 'RESOLVED' };
}
