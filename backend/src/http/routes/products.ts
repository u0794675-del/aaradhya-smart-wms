import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit, requestContext } from '../auth-guards.ts';
import { bulkDelete } from '../../services/bulk-delete.ts';
import {
  UOM_VALUES,
  addBarcode,
  addUomConversion,
  convertToBase,
  createBatch,
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
} from '../../services/products.ts';

const uomSchema = z.enum(UOM_VALUES);
const productCreateSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().min(2).max(50).optional(),
  parentSku: z.string().max(50).optional().nullable(),
  brand: z.string().max(100).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  subcategory: z.string().max(100).optional().nullable(),
  productType: z.string().max(100).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  baseUom: uomSchema,
  isBatchTracked: z.boolean().optional(),
  isExpiryTracked: z.boolean().optional(),
  qcRequired: z.boolean().optional(),
  costPrice: z.number().nonnegative().optional().nullable(),
  lowStockThreshold: z.number().int().nonnegative().optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  uomConversions: z
    .array(z.object({ fromUom: uomSchema, toUom: uomSchema, factor: z.number().int().positive().max(1_000_000) }))
    .max(20)
    .optional(),
});

const productUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  brand: z.string().max(100).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  subcategory: z.string().max(100).nullable().optional(),
  productType: z.string().max(100).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  isBatchTracked: z.boolean().optional(),
  isExpiryTracked: z.boolean().optional(),
  qcRequired: z.boolean().optional(),
  costPrice: z.number().nonnegative().nullable().optional(),
  lowStockThreshold: z.number().int().nonnegative().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export async function registerProductRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.post(
    '/api/products/bulk-delete',
    { preHandler: [authGuard(db), permit(db, 'product.manage')] },
    async (request, reply) => {
      const body = z
        .object({
          ids: z.array(z.string().uuid()).min(1).max(500),
          reason: z.string().min(3).max(500).optional(),
        })
        .parse(request.body);
      const result = bulkDelete(db, 'products', body.ids, currentUser(request), body.reason);
      return reply.send({ data: result });
    },
  );

  app.get('/api/products', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const user = currentUser(request);
    const query = z
      .object({
        search: z.string().max(100).optional(),
        category: z.string().max(100).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    const result = listProducts(db, { ...query, includeCost: user.permissions.includes('product.cost.read') });
    return reply.send({ data: result });
  });

  app.post('/api/products', { preHandler: [authGuard(db), permit(db, 'product.manage')] }, async (request, reply) => {
    const body = productCreateSchema.parse(request.body);
    const user = currentUser(request);
    const id = withTransaction(db, () => createProduct(db, body, user));
    const detail = getProduct(db, id, user.permissions.includes('product.cost.read'));
    return reply.code(201).send({ data: detail });
  });

  app.get('/api/products/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    return reply.send({ data: getProduct(db, id, user.permissions.includes('product.cost.read')) });
  });

  app.patch('/api/products/:id', { preHandler: [authGuard(db), permit(db, 'product.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = productUpdateSchema.parse(request.body);
    const user = currentUser(request);
    withTransaction(db, () => updateProduct(db, id, body, user));
    return reply.send({ data: getProduct(db, id, user.permissions.includes('product.cost.read')) });
  });

  app.post(
    '/api/products/:id/barcodes',
    { preHandler: [authGuard(db), permit(db, 'product.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({ barcode: z.string().min(1).max(100), type: z.enum(['EAN', 'CODE128', 'QR', 'INTERNAL']).default('INTERNAL') })
        .parse(request.body);
      const user = currentUser(request);
      withTransaction(db, () => addBarcode(db, id, body.barcode, body.type, user));
      return reply.code(201).send({ data: getProduct(db, id, true) });
    },
  );

  app.post(
    '/api/products/:id/conversions',
    { preHandler: [authGuard(db), permit(db, 'product.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({ fromUom: uomSchema, toUom: uomSchema, factor: z.number().int().positive().max(1_000_000) })
        .parse(request.body);
      const user = currentUser(request);
      withTransaction(db, () => addUomConversion(db, id, body.fromUom, body.toUom, body.factor, user));
      return reply.code(201).send({ data: getProduct(db, id, true) });
    },
  );

  app.post(
    '/api/products/:id/batches',
    { preHandler: [authGuard(db), permit(db, 'inbound.receive')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          batchNo: z.string().min(1).max(100),
          mfgDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          vendorId: z.string().uuid().optional().nullable(),
        })
        .parse(request.body);
      const user = currentUser(request);
      const batchId = withTransaction(db, () => createBatch(db, { productId: id, ...body }, user));
      return reply.code(201).send({ data: { batchId } });
    },
  );

  app.get(
    '/api/products/:id/convert',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = z
        .object({ quantity: z.coerce.number().int().positive(), uom: uomSchema })
        .parse(request.query);
      return reply.send({ data: { baseQuantity: convertToBase(db, id, query.quantity, query.uom) } });
    },
  );
}
