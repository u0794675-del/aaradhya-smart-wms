import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  approveCount,
  cancelCount,
  createCount,
  getCount,
  listCounts,
  recordCounts,
  rejectCount,
  submitCount,
} from '../../services/cycle-counts.ts';

export async function registerCycleCountRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get(
    '/api/cycle-counts',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const query = z
        .object({
          status: z.string().max(100).optional(),
          warehouseId: z.string().uuid().optional(),
          limit: z.coerce.number().int().positive().max(300).optional(),
          offset: z.coerce.number().int().nonnegative().optional(),
        })
        .parse(request.query);
      return reply.send({ data: listCounts(db, query) });
    },
  );

  app.post(
    '/api/cycle-counts',
    { preHandler: [authGuard(db), permit(db, 'cycle_count.manage')] },
    async (request, reply) => {
      const body = z
        .object({
          countType: z.enum(['AD_HOC', 'SCHEDULED', 'BLIND', 'LOCATION', 'SKU', 'BOX', 'BATCH', 'FULL']),
          locationId: z.string().uuid().optional().nullable(),
          boxId: z.string().uuid().optional().nullable(),
          batchId: z.string().uuid().optional().nullable(),
          productId: z.string().uuid().optional().nullable(),
          notes: z.string().max(1000).optional().nullable(),
          lines: z
            .array(
              z.object({
                productId: z.string().uuid(),
                locationId: z.string().uuid().optional().nullable(),
                poolId: z.string().uuid().optional().nullable(),
                batchId: z.string().uuid().optional().nullable(),
                boxId: z.string().uuid().optional().nullable(),
                countedQty: z.number().int().nonnegative().optional().nullable(),
                reason: z.string().max(500).optional().nullable(),
              }),
            )
            .min(1)
            .max(1000)
            .optional(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => createCount(db, body, user));
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/api/cycle-counts/:id',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ data: getCount(db, id) });
    },
  );

  app.post(
    '/api/cycle-counts/:id/count',
    { preHandler: [authGuard(db), permit(db, 'cycle_count.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          lines: z
            .array(
              z.object({
                lineId: z.string().uuid(),
                countedQty: z.number().int().nonnegative(),
                reason: z.string().max(500).optional().nullable(),
              }),
            )
            .min(1)
            .max(1000),
        })
        .parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => recordCounts(db, id, body, user)));
    },
  );

  app.post(
    '/api/cycle-counts/:id/submit',
    { preHandler: [authGuard(db), permit(db, 'cycle_count.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => submitCount(db, id, user)));
    },
  );

  app.post(
    '/api/cycle-counts/:id/approve',
    { preHandler: [authGuard(db), permit(db, 'cycle_count.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => approveCount(db, id, user)));
    },
  );

  app.post(
    '/api/cycle-counts/:id/reject',
    { preHandler: [authGuard(db), permit(db, 'cycle_count.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => rejectCount(db, id, body.reason, user)));
    },
  );

  app.post(
    '/api/cycle-counts/:id/cancel',
    { preHandler: [authGuard(db), permit(db, 'cycle_count.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => cancelCount(db, id, body.reason, user)));
    },
  );
}
