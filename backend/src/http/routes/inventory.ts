import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { idempotentMutation } from '../idempotency.ts';
import {
  availableQuantity,
  listBalances,
  listTransactions,
  reconcileInventory,
  reverseTransaction,
} from '../../services/inventory.ts';
import { inventoryOverview } from '../../services/operations.ts';

export async function registerInventoryRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get(
    '/api/inventory/balances',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const query = z
        .object({
          productId: z.string().uuid().optional(),
          sku: z.string().max(50).optional(),
          poolId: z.string().uuid().optional(),
          boxId: z.string().uuid().optional(),
          locationId: z.string().uuid().optional(),
          batchId: z.string().uuid().optional(),
          status: z
            .enum([
              'AVAILABLE', 'RESERVED', 'PICKED', 'IN_TRANSIT', 'QC_PENDING', 'QUARANTINED',
              'DAMAGED', 'REJECTED', 'EXPIRED', 'RETURN_PENDING', 'REWORK',
            ])
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query);
      const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
      return reply.send({ data: listBalances(db, { ...query, warehouseId: warehouse.id }) });
    },
  );

  app.get(
    '/api/inventory/ledger',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const query = z
        .object({
          productId: z.string().uuid().optional(),
          movementType: z.string().max(50).optional(),
          referenceId: z.string().max(100).optional(),
          boxId: z.string().uuid().optional(),
          userId: z.string().uuid().optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query);
      return reply.send({ data: listTransactions(db, query) });
    },
  );

  app.get(
    '/api/inventory/availability',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (request, reply) => {
      const query = z
        .object({
          productId: z.string().uuid().optional(),
          poolId: z.string().uuid().optional(),
          boxId: z.string().uuid().optional(),
          locationId: z.string().uuid().optional(),
        })
        .parse(request.query);
      const warehouse = db.prepare("SELECT id FROM warehouses WHERE code = 'WH1'").get() as { id: string };
      return reply.send({ data: { available: availableQuantity(db, { ...query, warehouseId: warehouse.id }) } });
    },
  );

  app.get(
    '/api/inventory/overview',
    { preHandler: [authGuard(db), permit(db, 'inventory.read')] },
    async (_request, reply) => {
      return reply.send({ data: inventoryOverview(db) });
    },
  );

  app.get(
    '/api/inventory/reconciliation',
    { preHandler: [authGuard(db), permit(db, 'audit.read')] },
    async (_request, reply) => {
      return reply.send({ data: reconcileInventory(db) });
    },
  );

  app.post(
    '/api/inventory/transactions/:id/reverse',
    { preHandler: [authGuard(db), permit(db, 'inventory.adjust.approve')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(5).max(500) }).parse(request.body);
      const user = currentUser(request);
      return reply.send(
        idempotentMutation(db, request, reply, () => {
          const reversalId = reverseTransaction(db, id, user, body.reason);
          return { transactionId: reversalId };
        }),
      );
    },
  );
}
