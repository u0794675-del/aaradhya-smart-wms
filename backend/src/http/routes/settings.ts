import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { withTransaction } from '../../db/index.ts';
import { authGuard, currentUser, permit } from '../auth-guards.ts';
import { listSettings } from '../../lib/settings.ts';
import { conflict } from '../../lib/errors.ts';
import { updateSetting } from '../../services/settings-write.ts';
import { isTotpEnrolled } from '../../services/report-security.ts';
import type { EmailSender } from '../../services/email.ts';

export async function registerSettingsRoutes(
  app: FastifyInstance,
  db: DB,
  sender: EmailSender,
): Promise<void> {
  app.get('/api/settings', { preHandler: [authGuard(db), permit(db, 'settings.manage')] }, async (_request, reply) => {
    return reply.send({ data: { rows: listSettings(db) } });
  });

  app.patch('/api/settings/:key', { preHandler: [authGuard(db), permit(db, 'settings.manage')] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = z.object({ value: z.union([z.string().max(200), z.number(), z.boolean()]) }).parse(request.body);
    const user = currentUser(request);
    if (key === 'report_otp_required' && body.value === true) {
      if (!isTotpEnrolled(db, user.id) && !sender.isConfigured()) {
        throw conflict(
          'OTP_CHANNEL_UNAVAILABLE',
          'Enroll an authenticator app or configure SMTP before making report OTP mandatory.',
        );
      }
    }
    const result = withTransaction(db, () => updateSetting(db, key, body.value, user));
    return reply.send({ data: result });
  });
}
