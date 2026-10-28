import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  approveAdjustment,
  createAdjustment,
  getAdjustment,
  listAdjustments,
  rejectAdjustment,
} from '../../services/adjustments.ts';

export async function registerAdjustmentRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/adjustments', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(100).optional(),
        productId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(300).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
      })
      .parse(request.query);
    return reply.send({ data: listAdjustments(db, query) });
  });

  app.post('/api/adjustments', { preHandler: [authGuard(db), permit(db, 'inventory.adjust')] }, async (request, reply) => {
    const body = z
      .object({
        productId: z.string().uuid(),
        locationId: z.string().uuid(),
        poolId: z.string().uuid(),
        batchId: z.string().uuid().optional().nullable(),
        boxId: z.string().uuid().optional().nullable(),
        direction: z.enum(['IN', 'OUT']),
        quantity: z.number().int().positive(),
        reason: z.string().min(3).max(500),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = idempotentMutation(db, request, reply, () => createAdjustment(db, body, user));
    return reply.code(201).send(result);
  });

  app.get('/api/adjustments/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getAdjustment(db, id) });
  });

  app.post(
    '/api/adjustments/:id/approve',
    { preHandler: [authGuard(db), permit(db, 'inventory.adjust.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ note: z.string().max(500).optional().nullable() }).parse(request.body ?? {});
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => approveAdjustment(db, id, user, body.note)));
    },
  );

  app.post(
    '/api/adjustments/:id/reject',
    { preHandler: [authGuard(db), permit(db, 'inventory.adjust.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => rejectAdjustment(db, id, body.reason, user)));
    },
  );
}
