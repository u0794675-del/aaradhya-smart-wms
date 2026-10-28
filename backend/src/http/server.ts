import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { DB } from '../db/index.ts';
import { AppError, isConstraintViolation } from '../lib/errors.ts';
import { config } from '../config.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerProductRoutes } from './routes/products.ts';
import { registerBoxRoutes } from './routes/boxes.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import { registerInboundRoutes } from './routes/inbound.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { registerOrderRoutes } from './routes/orders.ts';
import { registerTransferRoutes } from './routes/transfers.ts';
import { registerReturnRoutes } from './routes/returns.ts';
import { registerCycleCountRoutes } from './routes/cycle-counts.ts';
import { registerAdjustmentRoutes } from './routes/adjustments.ts';
import { registerControlRoutes } from './routes/control.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerExceptionRoutes } from './routes/exceptions.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerImportRoutes } from './routes/imports.ts';
import { registerAssistantRoutes } from './routes/assistant.ts';
import { registerSecurityRoutes } from './routes/security.ts';
import { registerGuideRoutes } from './routes/guide.ts';
import { registerFieldOperationRoutes } from './routes/fieldops.ts';
import { registerEmployeeRoutes } from './routes/employees.ts';
import { createEmailSender, type EmailSender } from '../services/email.ts';

export interface BuildServerOptions {
  db: DB;
  logger?: boolean | object;
  serveFrontend?: boolean;
  emailSender?: EmailSender;
  https?: { key: Buffer; cert: Buffer };
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { db } = options;
  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: false,
    ...(options.https ? { https: options.https } : {}),
  });

  app.decorateRequest('authUser', null);
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-correlation-id'];
    request.correlationId =
      typeof incoming === 'string' && incoming.length <= 200 ? incoming : randomUUID();
    reply.header('x-correlation-id', request.correlationId);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
    );

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        const expectedHost = request.headers.host;
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (!originHost || originHost !== expectedHost) {
          reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Cross-origin mutation denied' } });
          return reply;
        }
      }
    }
    return undefined;
  });

  await app.register(cookie);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }
    if (isConstraintViolation(error)) {
      request.log.warn({ err: error }, 'database constraint violation');
      return reply.code(409).send({
        error: { code: 'CONSTRAINT_VIOLATION', message: 'The operation conflicts with an existing record or rule' },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: config.isProduction ? 'An unexpected error occurred' : (error as Error).message,
      },
    });
  });

  await registerAuthRoutes(app, db);
  await registerHealthRoutes(app, db);
  await registerProductRoutes(app, db);
  await registerBoxRoutes(app, db);
  await registerInventoryRoutes(app, db);
  await registerInboundRoutes(app, db);
  await registerTaskRoutes(app, db);
  await registerOrderRoutes(app, db);
  await registerTransferRoutes(app, db);
  await registerReturnRoutes(app, db);
  await registerCycleCountRoutes(app, db);
  await registerAdjustmentRoutes(app, db);
  await registerControlRoutes(app, db);
  await registerAuditRoutes(app, db);
  await registerExceptionRoutes(app, db);
  const emailSender = options.emailSender ?? createEmailSender();
  await registerSecurityRoutes(app, db, emailSender);
  await registerReportRoutes(app, db, emailSender);
  await registerSettingsRoutes(app, db, emailSender);
  await registerNotificationRoutes(app, db);
  await registerImportRoutes(app, db);
  await registerAssistantRoutes(app, db);
  await registerGuideRoutes(app, db);
  await registerFieldOperationRoutes(app, db);
  await registerEmployeeRoutes(app, db);

  const serveFrontend = options.serveFrontend ?? true;
  const indexPath = path.join(config.frontendDist, 'index.html');
  if (serveFrontend && fs.existsSync(indexPath)) {
    await app.register(fastifyStatic, {
      root: config.frontendDist,
      prefix: '/',
      wildcard: false,
      decorateReply: true,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
    }
    if (serveFrontend && fs.existsSync(indexPath)) {
      // Hashed bundles change on every build; serve files created after boot
      // instead of asking for a restart, then fall back to the SPA shell.
      const pathname = decodeURIComponent(request.url.split('?')[0] ?? '/');
      const candidate = path.resolve(config.frontendDist, `.${pathname}`);
      if (candidate.startsWith(`${config.frontendDist}${path.sep}`)) {
        try {
          if (fs.statSync(candidate).isFile()) {
            return reply.sendFile(path.relative(config.frontendDist, candidate));
          }
        } catch {
          // Missing files fall through to index.html for client-side routes.
        }
      }
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  return app;
}
