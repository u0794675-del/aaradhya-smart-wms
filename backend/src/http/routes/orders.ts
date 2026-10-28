import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  allocateOrder,
  cancelOrder,
  confirmOrder,
  createOrder,
  dispatchOrder,
  getOrder,
  getShipment,
  listOrders,
  packOrder,
  pickOrder,
} from '../../services/orders.ts';

const orderLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  boxId: z.string().uuid().optional().nullable(),
});

export async function registerOrderRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/orders', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(200).optional(),
        channel: z.enum(['MANUAL', 'MARKETPLACE', 'B2B']).optional(),
        search: z.string().max(120).optional(),
        limit: z.coerce.number().int().positive().max(300).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
      })
      .parse(request.query);
    return reply.send({ data: listOrders(db, query) });
  });

  app.post('/api/orders', { preHandler: [authGuard(db), permit(db, 'order.manage')] }, async (request, reply) => {
    const body = z
      .object({
        channel: z.enum(['MANUAL', 'MARKETPLACE', 'B2B']),
        poolCode: z.enum(['B2B', 'SHARED']).optional(),
        warehouseId: z.string().uuid().optional(),
        customerName: z.string().min(1).max(200),
        customerRef: z.string().max(120).optional().nullable(),
        externalOrderId: z.string().max(120).optional().nullable(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
        slaDueAt: z.string().datetime({ offset: true }).optional().nullable(),
        notes: z.string().max(1000).optional().nullable(),
        lines: z.array(orderLineSchema).min(1).max(500),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = idempotentMutation(db, request, reply, () => createOrder(db, body, user));
    return reply.code(201).send(result);
  });

  app.get('/api/orders/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getOrder(db, id) });
  });

  app.post(
    '/api/orders/:id/confirm',
    { preHandler: [authGuard(db), permit(db, 'order.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => confirmOrder(db, id, user));
      return reply.send(result);
    },
  );

  app.post(
    '/api/orders/:id/allocate',
    { preHandler: [authGuard(db), permit(db, 'order.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => allocateOrder(db, id, user));
      return reply.send(result);
    },
  );

  app.post(
    '/api/orders/:id/pick',
    { preHandler: [authGuard(db), permit(db, 'picking.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          taskId: z.string().uuid().optional().nullable(),
          lines: z
            .array(
              z.object({
                orderLineId: z.string().uuid(),
                reservationId: z.string().uuid().optional().nullable(),
                quantity: z.number().int().positive(),
                scannedBoxId: z.string().max(120).optional().nullable(),
                scannedLocationId: z.string().max(120).optional().nullable(),
                scannedBarcode: z.string().max(120).optional().nullable(),
              }),
            )
            .min(1)
            .max(500),
        })
        .parse(request.body);
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => pickOrder(db, id, body, user));
      return reply.send(result);
    },
  );

  app.post(
    '/api/orders/:id/pack',
    { preHandler: [authGuard(db), permit(db, 'packing.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          packages: z
            .array(
              z.object({
                weightGrams: z.number().int().positive().optional().nullable(),
                dimensions: z.string().max(100).optional().nullable(),
                lines: z
                  .array(
                    z.object({
                      orderLineId: z.string().uuid(),
                      quantity: z.number().int().positive(),
                      batchId: z.string().uuid().optional().nullable(),
                    }),
                  )
                  .min(1),
              }),
            )
            .min(1)
            .optional(),
        })
        .parse(request.body ?? {});
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => packOrder(db, id, body, user));
      return reply.send(result);
    },
  );

  app.post(
    '/api/orders/:id/dispatch',
    { preHandler: [authGuard(db), permit(db, 'dispatch.execute')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          carrier: z.string().max(120).optional().nullable(),
          trackingNo: z.string().max(160).optional().nullable(),
          proof: z.record(z.unknown()).optional().nullable(),
        })
        .parse(request.body ?? {});
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => dispatchOrder(db, id, body, user));
      return reply.send(result);
    },
  );

  app.post(
    '/api/orders/:id/cancel',
    { preHandler: [authGuard(db), permit(db, 'order.cancel')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => cancelOrder(db, id, body.reason, user));
      return reply.send(result);
    },
  );

  app.get(
    '/api/shipments/:id',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ data: getShipment(db, id) });
    },
  );
}
