import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, requestContext } from '../auth-guards.ts';
import { USER_GUIDE } from '../../content/guide.ts';
import { getBranding } from '../../services/report-security.ts';
import { renderGuidePdf } from '../../services/guide-pdf.ts';
import { recordAudit } from '../../services/audit.ts';

export async function registerGuideRoutes(app: FastifyInstance, db: DB): Promise<void> {
  app.get('/api/guide', { preHandler: [authGuard(db)] }, async (_request, reply) => {
    return reply.send({ data: { guide: USER_GUIDE } });
  });

  app.get('/api/guide.pdf', { preHandler: [authGuard(db)] }, async (request, reply) => {
    const user = currentUser(request);
    const branding = getBranding(db);
    const buffer = await renderGuidePdf(USER_GUIDE, branding, user.name);
    recordAudit(db, {
      eventType: 'GUIDE_EXPORTED',
      entityType: 'GUIDE',
      entityId: USER_GUIDE.version,
      refs: { version: USER_GUIDE.version, language: 'Hinglish' },
      actor: {
        userId: user.id,
        role: user.role,
        ...requestContext(request),
      },
    });
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="warehouse-user-guide-v${USER_GUIDE.version}.pdf"`)
      .header('cache-control', 'no-store');
    return reply.send(buffer);
  });
}
