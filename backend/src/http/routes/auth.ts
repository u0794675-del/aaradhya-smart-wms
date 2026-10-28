import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { config } from '../../config.ts';
import { AppError } from '../../lib/errors.ts';
import { listSettings } from '../../lib/settings.ts';
import { login, logout, SESSION_COOKIE_NAME } from '../../services/auth.ts';
import { authGuard, currentUser, requestContext } from '../auth-guards.ts';

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;

function checkLimiter(key: string): void {
  const entry = failures.get(key);
  if (entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILURES) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts. Try again later.');
  }
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export async function registerAuthRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const context = requestContext(request);
    const limiterKey = `${request.ip}:${body.email.toLowerCase()}`;
    checkLimiter(limiterKey);
    try {
      const result = login(db, body.email, body.password, config.sessionHours, context);
      failures.delete(limiterKey);
      reply.setCookie(SESSION_COOKIE_NAME, result.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: config.sessionHours * 3600,
      });
      return reply.send({ data: { user: result.user } });
    } catch (error) {
      recordFailure(limiterKey);
      throw error;
    }
  });

  app.post('/api/auth/logout', { preHandler: [authGuard(db)] }, async (request, reply) => {
    const user = currentUser(request);
    logout(db, request.cookies[SESSION_COOKIE_NAME], user);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.send({ data: { ok: true } });
  });

  app.get('/api/auth/me', { preHandler: [authGuard(db)] }, async (request, reply) => {
    return reply.send({ data: { user: currentUser(request) } });
  });

  app.get('/api/meta', { preHandler: [authGuard(db)] }, async (request, reply) => {
    const user = currentUser(request);
    const warehouse = db.prepare("SELECT id, code, name FROM warehouses WHERE code = 'WH1'").get();
    const locations = db
      .prepare('SELECT id, code, type, zone, status FROM locations WHERE warehouse_id = ? ORDER BY code')
      .all((warehouse as { id: string }).id);
    const pools = db.prepare("SELECT id, code, name FROM stock_pools WHERE code IN ('B2B','SHARED') ORDER BY code").all();
    const settings = listSettings(db).filter((s) =>
      ['timezone', 'company_name', 'expiry_warning_days', 'low_stock_default', 'adjustment_approval_threshold'].includes(
        s.key,
      ),
    );
    return reply.send({ data: { user, warehouse, locations, pools, settings } });
  });
}
