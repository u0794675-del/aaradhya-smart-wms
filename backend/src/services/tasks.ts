import type { DB } from '../db/index.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, documentNo } from '../lib/ids.ts';
import { addHours, nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { recordAudit } from './audit.ts';

export type TaskType =
  | 'PUTAWAY' | 'PICKING' | 'QC' | 'PACKING' | 'RETURN_INSPECTION' | 'CYCLE_COUNT' | 'TRANSFER' | 'MAINTENANCE';

export const TASK_OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'BLOCKED', 'ON_HOLD'];

export function createTask(
  db: DB,
  input: {
    taskType: TaskType;
    warehouseId: string;
    entityType?: string | null;
    entityId?: string | null;
    description?: string | null;
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    assignedTo?: string | null;
    dueInHours?: number;
    dueAt?: string | null;
  },
  actor: AuthUser,
): { id: string; taskNo: string } {
  if (input.assignedTo) {
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(input.assignedTo);
    if (!user) throw notFound('Assigned user not found or inactive');
  }
  const id = newId();
  const taskNo = documentNo(db, 'TASK', 'TASK', 6);
  const dueAt = input.dueAt ?? addHours(input.dueInHours ?? 8);
  db.prepare(
    `INSERT INTO tasks
      (id, task_no, task_type, priority, status, assigned_to, warehouse_id, entity_type, entity_id,
       description, due_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    taskNo,
    input.taskType,
    input.priority ?? 'NORMAL',
    input.assignedTo ? 'ASSIGNED' : 'OPEN',
    input.assignedTo ?? null,
    input.warehouseId,
    input.entityType ?? null,
    input.entityId ?? null,
    input.description ?? null,
    dueAt,
    actor.id,
    nowIso(),
  );
  recordAudit(db, {
    eventType: 'TASK_CREATED',
    entityType: 'TASK',
    entityId: id,
    after: { taskNo, taskType: input.taskType, entityType: input.entityType ?? null, entityId: input.entityId ?? null },
    actor: { userId: actor.id, role: actor.role },
  });
  return { id, taskNo };
}

function loadTask(db: DB, id: string) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!task) throw notFound('Task not found');
  return task;
}

function updateTaskStatus(
  db: DB,
  task: Record<string, any>,
  status: string,
  actor: AuthUser,
  patch: { blocked_reason?: string | null; started_at?: string | null; completed_at?: string | null; assigned_to?: string | null } = {},
): void {
  const fields = ['status = ?'];
  const values: any[] = [status];
  if ('blocked_reason' in patch) {
    fields.push('blocked_reason = ?');
    values.push(patch.blocked_reason ?? null);
  }
  if (patch.started_at) {
    fields.push('started_at = ?');
    values.push(patch.started_at);
  }
  if (patch.completed_at) {
    fields.push('completed_at = ?');
    values.push(patch.completed_at);
  }
  if ('assigned_to' in patch) {
    fields.push('assigned_to = ?');
    values.push(patch.assigned_to ?? null);
  }
  values.push(task.id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  recordAudit(db, {
    eventType: `TASK_${status}`,
    entityType: 'TASK',
    entityId: task.id,
    before: { status: task.status, assignedTo: task.assigned_to },
    after: { status, assignedTo: patch.assigned_to ?? task.assigned_to, reason: patch.blocked_reason ?? null },
    actor: { userId: actor.id, role: actor.role },
  });
}

export function assignTask(db: DB, taskId: string, assignedTo: string | null, actor: AuthUser): void {
  const task = loadTask(db, taskId);
  if (['COMPLETED', 'CANCELLED'].includes(task.status)) throw conflict('TASK_CLOSED', 'Closed tasks cannot be reassigned');
  if (assignedTo) {
    const user = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(assignedTo);
    if (!user) throw notFound('Assigned user not found');
  }
  updateTaskStatus(db, task, assignedTo ? 'ASSIGNED' : 'OPEN', actor, { assigned_to: assignedTo });
}

export function claimTask(db: DB, taskId: string, actor: AuthUser): void {
  const task = loadTask(db, taskId);
  if (task.assigned_to && task.assigned_to !== actor.id) {
    throw forbidden('This task is assigned to another employee');
  }
  if (['COMPLETED', 'CANCELLED'].includes(task.status)) throw conflict('TASK_CLOSED', 'Task is already closed');
  updateTaskStatus(db, task, 'ACCEPTED', actor, { assigned_to: actor.id });
}

export function startTask(db: DB, taskId: string, actor: AuthUser): void {
  const task = loadTask(db, taskId);
  if (task.assigned_to && task.assigned_to !== actor.id && !actor.permissions.includes('task.assign')) {
    throw forbidden('Task is assigned to another employee');
  }
  if (!['ASSIGNED', 'ACCEPTED', 'ON_HOLD'].includes(task.status)) {
    throw conflict('INVALID_TASK_TRANSITION', `Cannot start a task in status ${task.status}`);
  }
  updateTaskStatus(db, task, 'IN_PROGRESS', actor, { started_at: task.started_at ?? nowIso() });
}

export function blockTask(db: DB, taskId: string, reason: string, actor: AuthUser): void {
  const task = loadTask(db, taskId);
  if (!reason.trim()) throw badRequest('REASON_REQUIRED', 'A block reason is required');
  updateTaskStatus(db, task, 'BLOCKED', actor, { blocked_reason: reason.trim() });
}

export function completeTask(db: DB, taskId: string, actor: AuthUser): void {
  const task = loadTask(db, taskId);
  if (['COMPLETED', 'CANCELLED'].includes(task.status)) return;
  updateTaskStatus(db, task, 'COMPLETED', actor, { completed_at: nowIso() });
}

export function listTasks(
  db: DB,
  filters: { status?: string; taskType?: string; assignedTo?: string; priority?: string; overdue?: boolean; warehouseId?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean);
    conditions.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.taskType) {
    conditions.push('t.task_type = ?');
    params.push(filters.taskType);
  }
  if (filters.assignedTo) {
    conditions.push('t.assigned_to = ?');
    params.push(filters.assignedTo);
  }
  if (filters.priority) {
    conditions.push('t.priority = ?');
    params.push(filters.priority);
  }
  if (filters.warehouseId) {
    conditions.push('t.warehouse_id = ?');
    params.push(filters.warehouseId);
  }
  if (filters.overdue) {
    conditions.push("t.due_at < ? AND t.status NOT IN ('COMPLETED','CANCELLED')");
    params.push(nowIso());
  }
  const limit = Math.min(filters.limit ?? 100, 300);
  const offset = filters.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name, c.name AS creator_name,
              CASE WHEN t.due_at < ? AND t.status NOT IN ('COMPLETED','CANCELLED') THEN 1 ELSE 0 END AS is_overdue
         FROM tasks t
         LEFT JOIN users u ON u.id = t.assigned_to
         LEFT JOIN users c ON c.id = t.created_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
                 t.due_at ASC
        LIMIT ? OFFSET ?`,
    )
    .all(nowIso(), ...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${conditions.join(' AND ')}`).get(...params) as { n: number };
  return { rows, total: Number(total.n), limit, offset };
}

export function getTask(db: DB, id: string) {
  const row = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.id = ? OR t.task_no = ?`,
    )
    .get(id, id.toUpperCase());
  if (!row) throw notFound('Task not found');
  return row;
}
