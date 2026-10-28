import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { DB } from '../db/index.ts';
import { AppError, forbidden, unauthorized } from '../lib/errors.ts';
import { authenticate, SESSION_COOKIE_NAME } from '../services/auth.ts';
import { recordAudit } from '../services/audit.ts';

export function authGuard(db: DB): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    request.authUser = authenticate(db, request.cookies[SESSION_COOKIE_NAME]);
  };
}

export function permit(db: DB, permission: string): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) throw unauthorized();
    if (!user.permissions.includes(permission)) {
      recordAudit(db, {
        eventType: 'PERMISSION_DENIED',
        entityType: 'ENDPOINT',
        entityId: `${request.method} ${request.url.split('?')[0]}`,
        outcome: 'FAILURE',
        reason: `Missing permission ${permission}`,
        refs: { permission, method: request.method, path: request.url.split('?')[0] },
        actor: {
          userId: user.id,
          role: user.role,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          correlationId: request.correlationId,
        },
      });
      throw forbidden('You do not have permission to perform this action', { permission });
    }
  };
}

export function permitAny(db: DB, permissions: string[]): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) throw unauthorized();
    if (permissions.some((permission) => user.permissions.includes(permission))) return;
    recordAudit(db, {
      eventType: 'PERMISSION_DENIED',
      entityType: 'ENDPOINT',
      entityId: `${request.method} ${request.url.split('?')[0]}`,
      outcome: 'FAILURE',
      reason: `Missing any of ${permissions.join(', ')}`,
      refs: { permissions, method: request.method, path: request.url.split('?')[0] },
      actor: {
        userId: user.id,
        role: user.role,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        correlationId: request.correlationId,
      },
    });
    throw forbidden('You do not have permission to perform this action', { permissions });
  };
}

export function requestContext(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    correlationId: request.correlationId,
  };
}

export function currentUser(request: FastifyRequest) {
  if (!request.authUser) throw unauthorized();
  return request.authUser;
}

export { AppError };
