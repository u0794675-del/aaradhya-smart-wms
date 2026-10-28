import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit, requestContext } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import { bulkDelete } from '../../services/bulk-delete.ts';
import {
  addBoxContents,
  boxTimeline,
  createBox,
  getBoxDetail,
  listBoxes,
  moveBox,
  removeBoxContents,
  retireBox,
  reuseBox,
} from '../../services/boxes.ts';
import { resolveBarcode } from '../../services/inventory.ts';

const contentSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  batchId: z.string().uuid().optional().nullable(),
  fromLocationId: z.string().uuid(),
  sourceBoxId: z.string().uuid().optional().nullable(),
  reason: z.string().max(500).optional(),
});

export async function registerBoxRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.post(
    '/api/boxes/bulk-delete',
    { preHandler: [authGuard(db), permit(db, 'box.manage')] },
    async (request, reply) => {
      const body = z
        .object({
          ids: z.array(z.string().uuid()).min(1).max(500),
          reason: z.string().min(3).max(500).optional(),
        })
        .parse(request.body);
      const result = bulkDelete(db, 'boxes', body.ids, currentUser(request), body.reason);
      return reply.send({ data: result });
    },
  );

  app.get('/api/boxes', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        search: z.string().max(100).optional(),
        type: z.enum(['SINGLE', 'MIXED']).optional(),
        status: z.enum(['ACTIVE', 'EMPTY', 'STAGING', 'DAMAGED', 'RETIRED']).optional(),
        locationId: z.string().uuid().optional(),
        poolId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    return reply.send({ data: listBoxes(db, query) });
  });

  app.post('/api/boxes', { preHandler: [authGuard(db), permit(db, 'box.manage')] }, async (request, reply) => {
    const body = z
      .object({
        boxType: z.enum(['SINGLE', 'MIXED']),
        locationId: z.string().uuid(),
        poolId: z.string().uuid(),
        notes: z.string().max(500).optional(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = withTransaction(db, () => createBox(db, { ...body, user }));
    return reply.code(201).send({ data: result });
  });

  app.get('/api/boxes/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = getBoxDetail(db, id);
    const timeline = boxTimeline(db, String(detail.box.id));
    return reply.send({ data: { ...detail, timeline } });
  });

  app.post(
    '/api/boxes/:id/contents',
    { preHandler: [authGuard(db), permit(db, 'inventory.move')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = contentSchema.parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      const result = idempotentMutation(db, request, reply, () =>
        addBoxContents(db, { boxId: id, ...body, user, correlationId: context.correlationId }),
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/api/boxes/:id/remove-contents',
    { preHandler: [authGuard(db), permit(db, 'inventory.move')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          productId: z.string().uuid(),
          quantity: z.number().int().positive(),
          batchId: z.string().uuid().optional().nullable(),
          toLocationId: z.string().uuid(),
          reason: z.string().max(500).optional(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      const result = idempotentMutation(db, request, reply, () =>
        removeBoxContents(db, { boxId: id, ...body, user, correlationId: context.correlationId }),
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/api/boxes/:id/move',
    { preHandler: [authGuard(db), permit(db, 'inventory.move')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({ toLocationId: z.string().uuid(), reason: z.string().max(500).optional() })
        .parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      const result = idempotentMutation(db, request, reply, () =>
        moveBox(db, { boxId: id, toLocationId: body.toLocationId, reason: body.reason, user, correlationId: context.correlationId }),
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/api/boxes/:id/retire',
    { preHandler: [authGuard(db), permit(db, 'box.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      withTransaction(db, () => retireBox(db, id, user, body.reason, context.correlationId));
      return reply.send({ data: { retired: true } });
    },
  );

  app.post(
    '/api/boxes/:id/reuse',
    { preHandler: [authGuard(db), permit(db, 'box.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ locationId: z.string().uuid(), poolId: z.string().uuid() }).parse(request.body);
      const user = currentUser(request);
      const context = requestContext(request);
      withTransaction(db, () => reuseBox(db, { boxId: id, ...body, user, correlationId: context.correlationId }));
      return reply.send({ data: getBoxDetail(db, id) });
    },
  );

  app.get(
    '/api/boxes/:id/timeline',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = getBoxDetail(db, id);
      return reply.send({ data: boxTimeline(db, String(detail.box.id)) });
    },
  );

  app.get('/api/scan/:barcode', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { barcode } = request.params as { barcode: string };
    return reply.send({ data: resolveBarcode(db, barcode) });
  });
}
