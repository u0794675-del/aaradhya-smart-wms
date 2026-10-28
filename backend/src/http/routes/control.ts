import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, permit } from '../auth-guards.ts';
import { controlTower, genealogy, searchAll } from '../../services/operations.ts';

export async function registerControlRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/control-tower', { preHandler: [authGuard(db), permit(db, 'control_tower.read')] }, async (_request, reply) => {
    return reply.send({ data: controlTower(db) });
  });

  app.get('/api/search', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z.object({ q: z.string().min(1).max(100) }).parse(request.query);
    return reply.send({ data: searchAll(db, query.q) });
  });

  app.get('/api/genealogy', { preHandler: [authGuard(db), permit(db, 'audit.read')] }, async (request, reply) => {
    const query = z
      .object({
        type: z.enum(['PRODUCT', 'BATCH', 'BOX', 'ORDER', 'RECEIPT', 'TRANSFER', 'RETURN', 'CYCLE_COUNT', 'ADJUSTMENT']),
        id: z.string().min(1).max(100),
      })
      .parse(request.query);
    return reply.send({ data: genealogy(db, query.type, query.id) });
  });
}
