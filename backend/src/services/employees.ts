import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { generatePassword, hashPassword } from '../lib/password.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { AuthUser } from './auth.ts';
import { userPermissions } from './auth.ts';
import { recordAudit } from './audit.ts';

export const EMPLOYEE_PERMISSION_CODES = [
  'picking.execute',
  'putaway.execute',
  'inventory.read',
  'task.manage',
  'exception.manage',
  'report.read',
] as const;

const EMPLOYEE_ROLES = new Set(['FIELD_OPERATOR', 'PICKER']);

// Seeded login accounts stay protected; they can be deactivated but not deleted.
const PROTECTED_EMPLOYEE_CODES = new Set(['EMP-0001', 'EMP-0002', 'EMP-0003', 'EMP-0004', 'EMP-0005', 'EMP-0006']);

export interface EmployeeBulkDeleteResult {
  deleted: string[];
  skipped: Array<{ id: string; reason: string }>;
}

function nextEmployeeCode(db: DB): string {
  const rows = db
    .prepare("SELECT employee_code FROM users WHERE employee_code LIKE 'EMP-%'")
    .all()
    .map((row) => String(row.employee_code));
  let max = 0;
  for (const code of rows) {
    const match = /^EMP-(\d+)$/.exec(code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `EMP-${String(max + 1).padStart(4, '0')}`;
}

function employeeRow(db: DB, id: string): Record<string, any> {
  const row = db
    .prepare(
      `SELECT u.id, u.employee_code, u.name, u.email, u.role_code, u.is_active,
              u.created_at, u.updated_at, u.last_login_at,
              (SELECT COUNT(*) FROM field_jobs j
                WHERE j.employee_id = u.id AND j.status IN ('ASSIGNED','IN_PROGRESS')) AS open_jobs,
              (SELECT COUNT(*) FROM field_operations o WHERE o.employee_id = u.id) AS completed_operations
         FROM users u WHERE u.id = ?`,
    )
    .get(id) as Record<string, any> | undefined;
  if (!row) throw notFound('Employee not found');
  const overrides = db
    .prepare('SELECT permission_code, effect FROM user_permissions WHERE user_id = ? ORDER BY permission_code')
    .all(id) as Array<{ permission_code: string; effect: string }>;
  return {
    ...row,
    permissions: userPermissions(db, String(row.role_code), id),
    overrides,
  };
}

export function listEmployees(
  db: DB,
  filters: { search?: string; role?: string; includeInactive?: boolean; limit?: number } = {},
) {
  const conditions = ["u.role_code IN ('FIELD_OPERATOR', 'PICKER')"];
  const params: unknown[] = [];
  if (!filters.includeInactive) conditions.push('u.is_active = 1');
  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    conditions.push('(u.name LIKE ? OR u.employee_code LIKE ? OR u.email LIKE ?)');
    params.push(term, term, term);
  }
  if (filters.role) {
    conditions.push('u.role_code = ?');
    params.push(filters.role);
  }
  const limit = Math.min(filters.limit ?? 200, 500);
  const rows = db
    .prepare(
      `SELECT u.id, u.employee_code, u.name, u.email, u.role_code, u.is_active,
              u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM field_jobs j
                WHERE j.employee_id = u.id AND j.status IN ('ASSIGNED','IN_PROGRESS')) AS open_jobs,
              (SELECT COUNT(*) FROM field_operations o WHERE o.employee_id = u.id) AS completed_operations
         FROM users u
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE u.is_active WHEN 1 THEN 0 ELSE 1 END, u.employee_code
        LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, any>>;
  return rows.map((row) => {
    const overrides = db
      .prepare('SELECT permission_code, effect FROM user_permissions WHERE user_id = ? ORDER BY permission_code')
      .all(row.id) as Array<{ permission_code: string; effect: string }>;
    return {
      ...row,
      permissions: userPermissions(db, String(row.role_code), String(row.id)),
      overrides,
    };
  });
}

function setPermissionOverrides(
  db: DB,
  userId: string,
  roleCode: string,
  desiredPermissions: string[],
  actor: AuthUser,
): void {
  const allowed = new Set<string>(EMPLOYEE_PERMISSION_CODES);
  for (const permission of desiredPermissions) {
    if (!allowed.has(permission)) {
      throw badRequest('INVALID_PERMISSION', `Permission ${permission} cannot be managed from Employees`);
    }
  }
  const rolePermissions = new Set(
    db
      .prepare('SELECT permission_code FROM role_permissions WHERE role_code = ?')
      .all(roleCode)
      .map((row) => String(row.permission_code)),
  );
  const desired = new Set(desiredPermissions);
  const now = nowIso();
  for (const permission of EMPLOYEE_PERMISSION_CODES) {
    const roleHas = rolePermissions.has(permission);
    const want = desired.has(permission);
    if (roleHas === want) {
      db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission_code = ?').run(userId, permission);
      continue;
    }
    const effect = want ? 'GRANT' : 'DENY';
    db.prepare(
      `INSERT INTO user_permissions (user_id, permission_code, effect, granted_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, permission_code)
       DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
    ).run(userId, permission, effect, actor.id, now, now);
  }
}

export function createEmployee(
  db: DB,
  input: {
    employeeCode?: string;
    name: string;
    email: string;
    password?: string;
    role?: string;
    permissions?: string[];
  },
  actor: AuthUser,
) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw badRequest('INVALID_NAME', 'Employee name must be 2-120 characters');
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('INVALID_EMAIL', 'A valid email is required');
  const role = input.role ?? 'FIELD_OPERATOR';
  if (!EMPLOYEE_ROLES.has(role)) throw badRequest('INVALID_ROLE', 'Employees can be FIELD_OPERATOR or PICKER');
  const employeeCode = (input.employeeCode?.trim() || nextEmployeeCode(db)).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(employeeCode)) {
    throw badRequest('INVALID_EMPLOYEE_CODE', 'Employee code must be 3-20 letters, digits or dashes');
  }
  if (db.prepare('SELECT 1 FROM users WHERE employee_code = ?').get(employeeCode)) {
    throw conflict('EMPLOYEE_CODE_EXISTS', `Employee code ${employeeCode} already exists`);
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw conflict('EMAIL_EXISTS', `A user with email ${email} already exists`);
  }
  const password = input.password?.trim() || generatePassword();
  if (password.length < 8) throw badRequest('WEAK_PASSWORD', 'Password must be at least 8 characters');
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, employee_code, name, email, password_hash, role_code, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, employeeCode, name, email, hashPassword(password), role, now, now);
  if (input.permissions) setPermissionOverrides(db, id, role, input.permissions, actor);
  recordAudit(db, {
    eventType: 'EMPLOYEE_CREATED',
    entityType: 'USER',
    entityId: id,
    after: {
      employeeCode,
      name,
      email,
      role,
      permissions: input.permissions ?? null,
      passwordGenerated: !input.password,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return {
    employee: employeeRow(db, id),
    temporaryPassword: input.password ? null : password,
  };
}

export function updateEmployee(
  db: DB,
  id: string,
  input: {
    employeeCode?: string;
    name?: string;
    email?: string;
    role?: string;
    isActive?: boolean;
    permissions?: string[];
  },
  actor: AuthUser,
) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!user) throw notFound('Employee not found');
  if (id === actor.id && input.isActive === false) {
    throw conflict('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
  }
  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.employeeCode !== undefined) {
    const code = input.employeeCode.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code)) {
      throw badRequest('INVALID_EMPLOYEE_CODE', 'Employee code must be 3-20 letters, digits or dashes');
    }
    const clash = db.prepare('SELECT 1 FROM users WHERE employee_code = ? AND id <> ?').get(code, id);
    if (clash) throw conflict('EMPLOYEE_CODE_EXISTS', `Employee code ${code} already exists`);
    updates.push('employee_code = ?');
    values.push(code);
  }
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 120) throw badRequest('INVALID_NAME', 'Employee name must be 2-120 characters');
    updates.push('name = ?');
    values.push(name);
  }
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('INVALID_EMAIL', 'A valid email is required');
    const clash = db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, id);
    if (clash) throw conflict('EMAIL_EXISTS', `A user with email ${email} already exists`);
    updates.push('email = ?');
    values.push(email);
  }
  if (input.role !== undefined) {
    if (!EMPLOYEE_ROLES.has(input.role)) throw badRequest('INVALID_ROLE', 'Employees can be FIELD_OPERATOR or PICKER');
    updates.push('role_code = ?');
    values.push(input.role);
  }
  if (input.isActive !== undefined) {
    updates.push('is_active = ?');
    values.push(input.isActive ? 1 : 0);
  }
  const roleAfter = String(input.role ?? user.role_code);
  if (updates.length) {
    updates.push('updated_at = ?');
    values.push(nowIso(), id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
  if (input.isActive === false) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), id);
  }
  if (input.permissions) setPermissionOverrides(db, id, roleAfter, input.permissions, actor);
  const after = employeeRow(db, id);
  recordAudit(db, {
    eventType: 'EMPLOYEE_UPDATED',
    entityType: 'USER',
    entityId: id,
    before: {
      employeeCode: user.employee_code,
      name: user.name,
      email: user.email,
      role: user.role_code,
      isActive: user.is_active,
    },
    after: {
      employeeCode: after.employee_code,
      name: after.name,
      email: after.email,
      role: after.role_code,
      isActive: after.is_active,
      permissions: input.permissions ?? null,
    },
    actor: { userId: actor.id, role: actor.role },
  });
  return after;
}

export function resetEmployeePassword(db: DB, id: string, actor: AuthUser) {
  const user = db.prepare('SELECT id, employee_code, name, email FROM users WHERE id = ?').get(id) as
    | Record<string, any>
    | undefined;
  if (!user) throw notFound('Employee not found');
  const password = generatePassword();
  const now = nowIso();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(password), now, id);
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, id);
  recordAudit(db, {
    eventType: 'EMPLOYEE_PASSWORD_RESET',
    entityType: 'USER',
    entityId: id,
    after: { employeeCode: user.employee_code, sessionsRevoked: true },
    actor: { userId: actor.id, role: actor.role },
  });
  return { email: user.email, password };
}

export function bulkDeleteEmployees(
  db: DB,
  rawIds: string[],
  actor: AuthUser,
  reason = 'Bulk delete from Employees',
): EmployeeBulkDeleteResult {
  const ids = [...new Set(rawIds.map((value) => value.trim()).filter(Boolean))];
  const result: EmployeeBulkDeleteResult = { deleted: [], skipped: [] };
  if (ids.length === 0) return result;

  const referenceCounts = (id: string) => {
    const checks: Array<[string, string]> = [
      ['field_jobs', 'employee_id = ? OR created_by = ?'],
      ['field_operations', 'employee_id = ? OR confirmed_by = ?'],
      ['tasks', 'assigned_to = ?'],
      ['product_sources', 'verified_by = ?'],
      ['box_sources', 'verified_by = ?'],
      ['report_branding', 'updated_by = ?'],
      ['user_permissions', 'granted_by = ?'],
    ];
    const found: Array<{ table: string; count: number }> = [];
    for (const [table, clause] of checks) {
      const placeholders = clause.split('?').length - 1;
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${clause}`)
        .get(...Array.from({ length: placeholders }, () => id)) as { n: number };
      if (Number(row.n) > 0) found.push({ table, count: Number(row.n) });
    }
    return found;
  };

  const before: unknown[] = [];
  withTransaction(db, () => {
    for (const id of ids) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, any> | undefined;
      if (!user) {
        result.skipped.push({ id, reason: 'Record not found' });
        continue;
      }
      if (id === actor.id) {
        result.skipped.push({ id, reason: 'You cannot delete your own account' });
        continue;
      }
      if (!EMPLOYEE_ROLES.has(String(user.role_code))) {
        result.skipped.push({ id, reason: 'Core system account — deactivate it instead of deleting' });
        continue;
      }
      if (PROTECTED_EMPLOYEE_CODES.has(String(user.employee_code))) {
        result.skipped.push({ id, reason: 'Seeded login account — deactivate it instead of deleting' });
        continue;
      }
      const blockers = referenceCounts(id);
      if (blockers.length > 0) {
        const linked = blockers.map((entry) => `${entry.table} (${entry.count})`).join(', ');
        result.skipped.push({ id, reason: `Linked to ${linked}; deactivate the employee instead` });
        continue;
      }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM report_otp_challenges WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      result.deleted.push(id);
      before.push({
        employeeCode: user.employee_code,
        name: user.name,
        email: user.email,
        role: user.role_code,
      });
    }

    if (result.deleted.length > 0) {
      recordAudit(db, {
        eventType: 'EMPLOYEE_BULK_DELETED',
        entityType: 'USER',
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
