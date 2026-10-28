import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { askAssistant } from '../../services/assistant.ts';

export async function registerAssistantRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.post('/api/assistant', { preHandler: [authGuard(db), permit(db, 'ai.use')] }, async (request, reply) => {
    const body = z.object({ question: z.string().min(1).max(1000) }).parse(request.body);
    const user = currentUser(request);
    return reply.send({ data: askAssistant(db, body.question, user) });
  });
}
