import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import { createReturn, getReturn, inspectReturn, listReturns } from '../../services/returns.ts';

const returnLineSchema = z.object({
  orderLineId: z.string().uuid().optional().nullable(),
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  batchId: z.string().uuid().optional().nullable(),
});

export async function registerReturnRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/returns', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(100).optional(),
        orderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(300).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
      })
      .parse(request.query);
    return reply.send({ data: listReturns(db, query) });
  });

  app.post('/api/returns', { preHandler: [authGuard(db), permit(db, 'return.inspect')] }, async (request, reply) => {
    const body = z
      .object({
        orderId: z.string().uuid(),
        reason: z.string().min(3).max(500),
        notes: z.string().max(1000).optional().nullable(),
        lines: z.array(returnLineSchema).min(1).max(200),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = idempotentMutation(db, request, reply, () => createReturn(db, body, user));
    return reply.code(201).send(result);
  });

  app.get('/api/returns/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getReturn(db, id) });
  });

  app.post(
    '/api/returns/:id/inspect',
    { preHandler: [authGuard(db), permit(db, 'return.inspect')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          restockLocationId: z.string().uuid().optional().nullable(),
          notes: z.string().max(1000).optional().nullable(),
          lines: z
            .array(
              z.object({
                returnLineId: z.string().uuid(),
                restockQty: z.number().int().nonnegative().optional(),
                damagedQty: z.number().int().nonnegative().optional(),
                rejectedQty: z.number().int().nonnegative().optional(),
                reworkQty: z.number().int().nonnegative().optional(),
                disposedQty: z.number().int().nonnegative().optional(),
              }),
            )
            .min(1)
            .max(200),
        })
        .parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => inspectReturn(db, id, body, user)));
    },
  );
}
