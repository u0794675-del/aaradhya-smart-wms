import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  approveTransfer,
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransfers,
  receiveTransfer,
} from '../../services/transfers.ts';

export async function registerTransferRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/transfers', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(200).optional(),
        limit: z.coerce.number().int().positive().max(300).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
      })
      .parse(request.query);
    return reply.send({ data: listTransfers(db, query) });
  });

  app.post('/api/transfers', { preHandler: [authGuard(db), permit(db, 'transfer.request')] }, async (request, reply) => {
    const body = z
      .object({
        transferType: z.enum(['POOL_TO_POOL', 'LOCATION_TO_LOCATION']),
        fromLocationId: z.string().uuid(),
        toLocationId: z.string().uuid().optional().nullable(),
        fromPoolId: z.string().uuid(),
        toPoolId: z.string().uuid(),
        transitLocationId: z.string().uuid().optional().nullable(),
        reason: z.string().max(500).optional().nullable(),
        lines: z
          .array(
            z.object({
              productId: z.string().uuid(),
              quantity: z.number().int().positive(),
              batchId: z.string().uuid().optional().nullable(),
              boxId: z.string().uuid().optional().nullable(),
              destinationLocationId: z.string().uuid().optional().nullable(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = idempotentMutation(db, request, reply, () => createTransfer(db, body, user));
    return reply.code(201).send(result);
  });

  app.get('/api/transfers/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getTransfer(db, id) });
  });

  app.post(
    '/api/transfers/:id/approve',
    { preHandler: [authGuard(db), permit(db, 'transfer.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => approveTransfer(db, id, user)));
    },
  );

  app.post(
    '/api/transfers/:id/dispatch',
    { preHandler: [authGuard(db), permit(db, 'transfer.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => dispatchTransfer(db, id, user)));
    },
  );

  app.post(
    '/api/transfers/:id/receive',
    { preHandler: [authGuard(db), permit(db, 'transfer.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          lines: z
            .array(z.object({ lineId: z.string().uuid(), quantity: z.number().int().positive() }))
            .min(1)
            .max(200)
            .optional(),
        })
        .parse(request.body ?? {});
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => receiveTransfer(db, id, body, user)));
    },
  );

  app.post(
    '/api/transfers/:id/cancel',
    { preHandler: [authGuard(db), permit(db, 'transfer.request')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => cancelTransfer(db, id, body.reason, user)));
    },
  );
}
