import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import {
  acknowledgeNotification,
  listNotifications,
  resolveNotification,
} from '../../services/notifications.ts';

export async function registerNotificationRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/notifications', { preHandler: [authGuard(db), permit(db, 'inventory.read')] }, async (request, reply) => {
    const query = z
      .object({
        status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
        limit: z.coerce.number().int().min(1).max(300).optional(),
      })
      .parse(request.query);
    return reply.send({ data: listNotifications(db, query) });
  });

  app.post(
    '/api/notifications/:id/acknowledge',
    { preHandler: [authGuard(db), permit(db, 'exception.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = currentUser(request);
      const result = withTransaction(db, () => acknowledgeNotification(db, id, user));
      return reply.send({ data: result });
    },
  );

  app.post(
    '/api/notifications/:id/resolve',
    { preHandler: [authGuard(db), permit(db, 'exception.manage')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      const user = currentUser(request);
      const result = withTransaction(db, () => resolveNotification(db, id, user, body.reason));
      return reply.send({ data: result });
    },
  );
}
