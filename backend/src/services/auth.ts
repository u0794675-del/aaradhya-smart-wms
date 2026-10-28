import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.ts';
import { withTransaction } from '../db/index.ts';
import { unauthorized } from '../lib/errors.ts';
import { verifyPassword } from '../lib/password.ts';
import { nowIso } from '../lib/time.ts';
import { newId } from '../lib/ids.ts';
import { recordAudit } from './audit.ts';

export interface AuthUser {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

export interface SessionContext {
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

const SESSION_COOKIE = 'aaradhya_session';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function userPermissions(db: DB, roleCode: string, userId?: string): string[] {
  const permissions = new Set(
    db
      .prepare('SELECT permission_code FROM role_permissions WHERE role_code = ? ORDER BY permission_code')
      .all(roleCode)
      .map((row) => String(row.permission_code)),
  );
  if (userId) {
    const overrides = db
      .prepare('SELECT permission_code, effect FROM user_permissions WHERE user_id = ?')
      .all(userId) as Array<{ permission_code: string; effect: string }>;
    for (const override of overrides) {
      if (override.effect === 'GRANT') permissions.add(override.permission_code);
      else permissions.delete(override.permission_code);
    }
  }
  return Array.from(permissions).sort();
}

export function login(
  db: DB,
  email: string,
  password: string,
  sessionHours: number,
  context: SessionContext,
): { token: string; user: AuthUser } {
  const user = db
    .prepare('SELECT id, employee_code, name, email, password_hash, role_code, is_active FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as
    | {
        id: string;
        employee_code: string;
        name: string;
        email: string;
        password_hash: string;
        role_code: string;
        is_active: number;
      }
    | undefined;

  if (!user || user.is_active !== 1 || !verifyPassword(password, user.password_hash)) {
    recordAudit(db, {
      eventType: 'AUTH_LOGIN_FAILED',
      entityType: 'USER',
      entityId: user?.id ?? null,
      outcome: 'FAILURE',
      reason: user ? 'Invalid credentials' : 'Unknown account',
      actor: { ip: context.ip, userAgent: context.userAgent, correlationId: context.correlationId },
    });
    throw unauthorized('Invalid email or password');
  }

  const token = randomBytes(32).toString('base64url');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + sessionHours * 3600_000).toISOString();
  withTransaction(db, () => {
    db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(now);
    db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(tokenHash(token), user.id, now, expiresAt, context.ip ?? null, context.userAgent ?? null);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
    recordAudit(db, {
      eventType: 'AUTH_LOGIN_SUCCESS',
      entityType: 'USER',
      entityId: user.id,
      actor: {
        userId: user.id,
        role: user.role_code,
        ip: context.ip,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      },
    });
  });

  return {
    token,
    user: {
      id: user.id,
      employeeCode: user.employee_code,
      name: user.name,
      email: user.email,
      role: user.role_code,
      permissions: userPermissions(db, user.role_code, user.id),
    },
  };
}

export function authenticate(db: DB, token: string | undefined): AuthUser {
  if (!token) throw unauthorized();
  const hash = tokenHash(token);
  const row = db
    .prepare(
      `SELECT u.id, u.employee_code, u.name, u.email, u.role_code, u.is_active, s.expires_at, s.revoked_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hash) as
    | {
        id: string;
        employee_code: string;
        name: string;
        email: string;
        role_code: string;
        is_active: number;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;

  if (!row || row.revoked_at || row.is_active !== 1 || row.expires_at <= nowIso()) {
    throw unauthorized('Session expired or invalid');
  }

  return {
    id: row.id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.email,
    role: row.role_code,
    permissions: userPermissions(db, row.role_code, row.id),
  };
}

export function logout(db: DB, token: string | undefined, actor: AuthUser): void {
  if (!token) return;
  withTransaction(db, () => {
    const result = db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(nowIso(), tokenHash(token));
    if (Number(result.changes) > 0) {
      recordAudit(db, {
        eventType: 'AUTH_LOGOUT',
        entityType: 'USER',
        entityId: actor.id,
        actor: { userId: actor.id, role: actor.role },
      });
    }
  });
}

export function createUser(
  db: DB,
  input: {
    employeeCode: string;
    name: string;
    email: string;
    passwordHash: string;
    role: string;
  },
  actor: AuthUser,
): string {
  const id = newId();
  const now = nowIso();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO users (id, employee_code, name, email, password_hash, role_code, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, input.employeeCode, input.name, input.email.toLowerCase(), input.passwordHash, input.role, now, now);
    recordAudit(db, {
      eventType: 'USER_CREATED',
      entityType: 'USER',
      entityId: id,
      after: { employeeCode: input.employeeCode, email: input.email, role: input.role },
      actor: { userId: actor.id, role: actor.role },
    });
  });
  return id;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
