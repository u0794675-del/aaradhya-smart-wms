import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit, permitAny, requestContext } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  cancelFieldJob,
  confirmPick,
  confirmPutaway,
  createFieldJob,
  getFieldJob,
  listFieldEmployees,
  listFieldHistory,
  listFieldJobs,
  startFieldJob,
} from '../../services/fieldops.ts';

const FIELD_ACCESS = ['picking.execute', 'putaway.execute', 'task.assign', 'user.manage', 'audit.read'];

export async function registerFieldOperationRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get(
    '/api/fieldops/employees',
    { preHandler: [authGuard(db), permit(db, 'task.assign')] },
    async (request, reply) => {
      const query = z.object({ search: z.string().max(100).optional() }).parse(request.query);
      return reply.send({ data: listFieldEmployees(db, query) });
    },
  );

  app.get(
    '/api/fieldops/jobs',
    { preHandler: [authGuard(db), permitAny(db, FIELD_ACCESS)] },
    async (request, reply) => {
      const query = z
        .object({
          jobType: z.enum(['PUTAWAY', 'PICK']).optional(),
          status: z.string().max(120).optional(),
          employeeId: z.string().uuid().optional(),
          search: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(300).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query);
      return reply.send({ data: listFieldJobs(db, currentUser(request), query) });
    },
  );

  app.post(
    '/api/fieldops/jobs',
    { preHandler: [authGuard(db), permit(db, 'task.assign')] },
    async (request, reply) => {
      const body = z
        .object({
          jobType: z.enum(['PUTAWAY', 'PICK']),
          boxId: z.string().uuid(),
          employeeId: z.string().uuid(),
          destinationLocationId: z.string().uuid().optional(),
          productId: z.string().uuid().optional().nullable(),
          pickMode: z.enum(['BOX', 'UNITS']).optional(),
          pickQuantity: z.number().int().positive().optional().nullable(),
          notes: z.string().max(500).optional().nullable(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const job = withTransaction(db, () => createFieldJob(db, body, user));
      return reply.code(201).send({ data: job });
    },
  );

  app.get(
    '/api/fieldops/jobs/:id',
    { preHandler: [authGuard(db), permitAny(db, FIELD_ACCESS)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ data: getFieldJob(db, id, currentUser(request)) });
    },
  );

  app.post(
    '/api/fieldops/jobs/:id/start',
    { preHandler: [authGuard(db), permitAny(db, ['picking.execute', 'putaway.execute', 'task.assign'])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      const result = withTransaction(db, () => startFieldJob(db, id, user));
      return reply.send({ data: result });
    },
  );

  app.post(
    '/api/fieldops/jobs/:id/confirm-putaway',
    { preHandler: [authGuard(db), permit(db, 'putaway.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          boxCode: z.string().min(1).max(100),
          destinationCode: z.string().min(1).max(100),
          notes: z.string().max(500).optional().nullable(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      const result = idempotentMutation(db, request, reply, () =>
        confirmPutaway(db, id, body, user, context.correlationId),
      );
      return reply.send(result);
    },
  );

  app.post(
    '/api/fieldops/jobs/:id/confirm-pick',
    { preHandler: [authGuard(db), permit(db, 'picking.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          locationCode: z.string().min(1).max(100),
          boxCode: z.string().min(1).max(100),
          notes: z.string().max(500).optional().nullable(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      const result = idempotentMutation(db, request, reply, () =>
        confirmPick(db, id, body, user, context.correlationId),
      );
      return reply.send(result);
    },
  );

  app.post(
    '/api/fieldops/jobs/:id/cancel',
    { preHandler: [authGuard(db), permit(db, 'task.assign')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      const result = withTransaction(db, () => cancelFieldJob(db, id, body.reason, user));
      return reply.send({ data: result });
    },
  );

  app.get(
    '/api/fieldops/history',
    { preHandler: [authGuard(db), permitAny(db, ['picking.execute', 'putaway.execute', 'audit.read', 'task.assign'])] },
    async (request, reply) => {
      const query = z
        .object({
          type: z.enum(['PUTAWAY', 'PICK']).optional(),
          employeeId: z.string().uuid().optional(),
          employee: z.string().max(100).optional(),
          brand: z.string().max(100).optional(),
          box: z.string().max(100).optional(),
          location: z.string().max(100).optional(),
          from: z.string().max(40).optional(),
          to: z.string().max(40).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query);
      return reply.send({ data: listFieldHistory(db, currentUser(request), query) });
    },
  );
}
