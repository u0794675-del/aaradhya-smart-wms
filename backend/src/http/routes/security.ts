import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/index.ts';
import { authGuard, currentUser, permit, requestContext } from '../auth-guards.ts';
import type { EmailSender } from '../../services/email.ts';
import {
  confirmTotpEnrollment,
  disableTotp,
  getBranding,
  REPORT_TEMPLATES,
  securityStatus,
  sendTestEmail,
  startTotpEnrollment,
  updateBranding,
} from '../../services/report-security.ts';

const brandingSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  tagline: z.string().max(150).nullable().optional(),
  addressLine: z.string().max(300).nullable().optional(),
  contactLine: z.string().max(200).nullable().optional(),
  logoDataUrl: z.string().max(4_000_000).nullable().optional(),
  watermarkText: z.string().max(60).nullable().optional(),
  watermarkOpacity: z.number().min(0).max(0.5),
  footerNote: z.string().max(220).nullable().optional(),
  template: z.enum(REPORT_TEMPLATES),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

export async function registerSecurityRoutes(
  app: FastifyInstance,
  db: DB,
  sender: EmailSender,
): Promise<void> {
  app.get('/api/security/status', { preHandler: [authGuard(db)] }, async (request, reply) => {
    return reply.send({ data: securityStatus(db, currentUser(request), sender) });
  });

  app.post('/api/security/totp/start', { preHandler: [authGuard(db)] }, async (request, reply) => {
    const user = currentUser(request);
    const data = await startTotpEnrollment(db, user, requestContext(request));
    return reply.send({ data });
  });

  app.post('/api/security/totp/confirm', { preHandler: [authGuard(db)] }, async (request, reply) => {
    const body = z.object({ code: z.string().min(6).max(12) }).parse(request.body);
    const data = confirmTotpEnrollment(db, currentUser(request), body.code, requestContext(request));
    return reply.send({ data });
  });

  app.post('/api/security/totp/disable', { preHandler: [authGuard(db)] }, async (request, reply) => {
    const body = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const data = disableTotp(db, currentUser(request), body.password, sender, requestContext(request));
    return reply.send({ data });
  });

  app.post(
    '/api/security/test-email',
    { preHandler: [authGuard(db), permit(db, 'settings.manage')] },
    async (request, reply) => {
      const data = await sendTestEmail(db, currentUser(request), sender, requestContext(request));
      return reply.send({ data });
    },
  );

  app.get('/api/report-branding', { preHandler: [authGuard(db), permit(db, 'report.read')] }, async (_request, reply) => {
    return reply.send({ data: { branding: getBranding(db) } });
  });

  app.patch(
    '/api/report-branding',
    { preHandler: [authGuard(db), permit(db, 'settings.manage')] },
    async (request, reply) => {
      const body = brandingSchema.parse(request.body);
      const branding = updateBranding(
        db,
        {
          companyName: body.companyName,
          tagline: body.tagline ?? null,
          addressLine: body.addressLine ?? null,
          contactLine: body.contactLine ?? null,
          logoDataUrl: body.logoDataUrl ?? null,
          watermarkText: body.watermarkText ?? null,
          watermarkOpacity: body.watermarkOpacity,
          footerNote: body.footerNote ?? null,
          template: body.template,
          primaryColor: body.primaryColor,
          accentColor: body.accentColor,
        },
        currentUser(request),
        requestContext(request),
      );
      return reply.send({ data: { branding } });
    },
  );
}
