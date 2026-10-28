import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, permit } from '../auth-guards.ts';
import { listAudit } from '../../services/audit-query.ts';

export async function registerAuditRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/audit', { preHandler: [authGuard(db), permit(db, 'audit.read')] }, async (request, reply) => {
    const query = z
      .object({
        eventType: z.string().max(100).optional(),
        entityType: z.string().max(100).optional(),
        entityId: z.string().max(200).optional(),
        actorUserId: z.string().uuid().optional(),
        transactionId: z.string().uuid().optional(),
        outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
        search: z.string().max(200).optional(),
        from: z.string().max(40).optional(),
        to: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    return reply.send({ data: listAudit(db, query) });
  });
}
