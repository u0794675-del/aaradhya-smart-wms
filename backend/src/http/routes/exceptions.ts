import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { createException, getException, listExceptions, updateException } from '../../services/exceptions.ts';

export async function registerExceptionRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/exceptions', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(100).optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        type: z.string().max(100).optional(),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(300).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    return reply.send({ data: listExceptions(db, query) });
  });

  app.get('/api/exceptions/:id', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ data: getException(db, id) });
  });

  app.post('/api/exceptions', { preHandler: [authGuard(db), permit(db, 'exception.manage')] }, async (request, reply) => {
    const body = z
      .object({
        type: z.string().min(2).max(100),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        entityType: z.string().max(100).optional().nullable(),
        entityId: z.string().max(200).optional().nullable(),
        description: z.string().min(5).max(2000),
        ownerUserId: z.string().uuid().optional().nullable(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = withTransaction(db, () => createException(db, body, user));
    return reply.code(201).send({ data: result });
  });

  app.patch('/api/exceptions/:id', { preHandler: [authGuard(db), permit(db, 'exception.manage')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED']).optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        resolution: z.string().max(2000).optional().nullable(),
        ownerUserId: z.string().uuid().optional().nullable(),
      })
      .parse(request.body);
    const user = currentUser(request);
    const result = withTransaction(db, () => updateException(db, id, body, user));
    return reply.send({ data: result });
  });
}
