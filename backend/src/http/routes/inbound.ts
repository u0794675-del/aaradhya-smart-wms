import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit, requestContext } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  createReceipt,
  createVendor,
  getPurchaseOrder,
  getReceipt,
  inspectReceiptLine,
  listPurchaseOrders,
  listReceipts,
  listVendors,
  putaway,
  releaseQuarantine,
  updateVendor,
  vendorPerformance,
} from '../../services/inbound.ts';
import { UOM_VALUES } from '../../services/products.ts';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const emptyToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? null : value), schema.nullable().optional());

const vendorSchema = z.object({
  name: z.string().min(1).max(200),
  vendorCode: z.string().max(30).optional(),
  gstin: z.string().max(30).optional().nullable(),
  contactName: z.string().max(120).optional().nullable(),
  email: z.string().email().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  address: z.string().max(1000).optional().nullable(),
  paymentTerms: z.string().max(100).optional().nullable(),
  leadTimeDays: z.number().int().nonnegative().optional().nullable(),
  minOrderQty: z.number().int().nonnegative().optional().nullable(),
});

export async function registerInboundRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/vendors', { preHandler: [authGuard(db), permit(db, 'inbound.receive')] }, async (request, reply) => {
    const query = z.object({ search: z.string().max(100).optional(), status: z.string().max(20).optional() }).parse(request.query);
    return reply.send({ data: listVendors(db, query) });
  });

  app.post('/api/vendors', { preHandler: [authGuard(db), permit(db, 'inbound.approve')] }, async (request, reply) => {
    const body = vendorSchema.parse(request.body);
    const user = currentUser(request);
    const id = withTransaction(db, () => createVendor(db, body, user));
    return reply.code(201).send({ data: { id } });
  });

  app.patch('/api/vendors/:id', { preHandler: [authGuard(db), permit(db, 'inbound.approve')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = vendorSchema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional() }).parse(request.body);
    const user = currentUser(request);
    withTransaction(db, () => updateVendor(db, id, body, user));
    return reply.send({ data: { ok: true } });
  });

  app.get(
    '/api/vendors/:id/performance',
    { preHandler: [authGuard(db), permit(db, 'report.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return reply.send({ data: vendorPerformance(db, id) });
    },
  );

  app.get('/api/purchase-orders', { preHandler: [authGuard(db), permit(db, 'inbound.receive')] }, async (request, reply) => {
    const query = z
      .object({ status: z.string().max(30).optional(), vendorId: z.string().uuid().optional() })
      .parse(request.query);
    return reply.send({ data: listPurchaseOrders(db, query) });
  });

  app.post('/api/purchase-orders', { preHandler: [authGuard(db), permit(db, 'inbound.receive')] }, async (request, reply) => {
    const body = z
      .object({
        vendorId: z.string().uuid(),
        expectedDate: dateSchema.optional().nullable(),
        notes: z.string().max(1000).optional().nullable(),
        lines: z
          .array(
            z.object({
              productId: z.string().uuid(),
              orderedQty: z.number().int().positive(),
              unitCost: z.number().nonnegative().optional().nullable(),
              uom: z.enum(UOM_VALUES).optional(),
            }),
          )
          .min(1)
          .max(500),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = withTransaction(db, () => createPurchaseOrder(db, body, user));
    return reply.code(201).send({ data: result });
  });

  app.get('/api/purchase-orders/:id', { preHandler: [authGuard(db), permit(db, 'inbound.receive')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getPurchaseOrder(db, id) });
  });

  app.post(
    '/api/purchase-orders/:id/approve',
    { preHandler: [authGuard(db), permit(db, 'inbound.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      withTransaction(db, () => approvePurchaseOrder(db, id, user));
      return reply.send({ data: getPurchaseOrder(db, id) });
    },
  );

  app.get('/api/receipts', { preHandler: [authGuard(db), permit(db, 'inbound.receive')] }, async (request, reply) => {
    const query = z
      .object({ status: z.string().max(30).optional(), vendorId: z.string().uuid().optional(), poId: z.string().uuid().optional() })
      .parse(request.query);
    return reply.send({ data: listReceipts(db, query) });
  });

  app.post(
    '/api/receipts',
    { preHandler: [authGuard(db), permit(db, 'inbound.receive')] },
    async (request, reply) => {
      const body = z
        .object({
          poId: z.string().uuid(),
          stagingLocationId: z.string().uuid(),
          poolId: z.string().uuid(),
          vendorInvoiceRef: z.string().max(100).optional().nullable(),
          notes: z.string().max(1000).optional().nullable(),
          allowExcess: z.boolean().optional(),
          excessReason: z.string().max(500).optional().nullable(),
          lines: z
            .array(
              z.object({
                poLineId: z.string().uuid().optional(),
                productId: z.string().uuid(),
                quantity: z.number().int().positive(),
                uom: z.enum(UOM_VALUES).optional(),
                batchId: z.string().uuid().optional().nullable(),
                batchNo: z.string().max(100).optional().nullable(),
                mfgDate: dateSchema.optional().nullable(),
                expiryDate: dateSchema.optional().nullable(),
              }),
            )
            .min(1)
            .max(500),
        })
        .parse(request.body);
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () => createReceipt(db, body, user));
      return reply.code(201).send(result);
    },
  );

  app.get('/api/receipts/:id', { preHandler: [authGuard(db), permit(db, 'inbound.receive')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getReceipt(db, id) });
  });

  app.post(
    '/api/receipts/:id/lines/:lineId/inspect',
    { preHandler: [authGuard(db), permit(db, 'qc.inspect')] },
    async (request, reply) => {
      const { id, lineId } = request.params as { id: string; lineId: string };
      const body = z
        .object({
          acceptedQty: z.number().int().nonnegative(),
          rejectedQty: z.number().int().nonnegative().optional(),
          quarantinedQty: z.number().int().nonnegative().optional(),
          notes: z.string().max(1000).optional().nullable(),
          template: z.record(z.unknown()).optional().nullable(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const result = idempotentMutation(db, request, reply, () =>
        inspectReceiptLine(db, { receiptId: id, lineId, ...body }, user),
      );
      return reply.send(result);
    },
  );

  app.post(
    '/api/putaway',
    { preHandler: [authGuard(db), permit(db, 'putaway.execute')] },
    async (request, reply) => {
      const body = z
        .object({
          receiptId: z.string().uuid(),
          productId: z.string().uuid(),
          batchId: z.string().uuid().optional().nullable(),
          quantity: z.number().int().positive(),
          toLocationId: z.string().uuid(),
          boxId: z.string().uuid().optional().nullable(),
          taskId: z.string().uuid().optional().nullable(),
          reason: z.string().max(500).optional(),
        })
        .parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => putaway(db, body, user)));
    },
  );

  app.post(
    '/api/quarantine/release',
    { preHandler: [authGuard(db), permit(db, 'inventory.adjust.approve')] },
    async (request, reply) => {
      const body = z
        .object({
          productId: z.string().uuid(),
          batchId: z.string().uuid().optional().nullable(),
          quantity: z.number().int().positive(),
          fromLocationId: z.string().uuid(),
          poolId: z.string().uuid(),
          toStatus: z.enum(['AVAILABLE', 'REJECTED']),
          reason: z.string().min(3).max(500),
        })
        .parse(request.body);
      const user = currentUser(request);
      return reply.send(idempotentMutation(db, request, reply, () => releaseQuarantine(db, body, user)));
    },
  );
}
