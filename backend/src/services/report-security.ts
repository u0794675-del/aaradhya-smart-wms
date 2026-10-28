import { randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { withTransaction, type DB } from '../db/index.ts';
import { getSetting } from '../lib/settings.ts';
import { nowIso } from '../lib/time.ts';
import { newId } from '../lib/ids.ts';
import { badRequest, conflict, notFound, AppError } from '../lib/errors.ts';
import { verifyPassword } from '../lib/password.ts';
import { decryptSecret, encryptSecret, hmacDigest } from '../lib/secret-box.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.ts';
import { recordAudit } from './audit.ts';
import { updateSetting } from './settings-write.ts';
import type { AuthUser } from './auth.ts';
import { escapeHtml, maskEmail, type EmailSender } from './email.ts';

export const REPORT_TEMPLATES = ['EXECUTIVE', 'CLASSIC', 'MINIMAL'] as const;
export type ReportTemplate = (typeof REPORT_TEMPLATES)[number];

export type OtpChannel = 'TOTP' | 'EMAIL';

export interface SecurityContext {
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface ReportBranding {
  companyName: string;
  tagline: string | null;
  addressLine: string | null;
  contactLine: string | null;
  logoDataUrl: string | null;
  logoMime: 'image/png' | 'image/jpeg' | null;
  watermarkText: string | null;
  watermarkOpacity: number;
  footerNote: string | null;
  template: ReportTemplate;
  primaryColor: string;
  accentColor: string;
  updatedAt: string | null;
}

export interface BrandingInput {
  companyName: string;
  tagline: string | null;
  addressLine: string | null;
  contactLine: string | null;
  logoDataUrl: string | null;
  watermarkText: string | null;
  watermarkOpacity: number;
  footerNote: string | null;
  template: ReportTemplate;
  primaryColor: string;
  accentColor: string;
}

const EMAIL_OTP_TTL_MS = 5 * 60_000;
const EMAIL_OTP_WINDOW_MS = 10 * 60_000;
const EMAIL_OTP_MAX_PER_WINDOW = 3;
const EMAIL_OTP_MAX_ATTEMPTS = 5;
const TOTP_MAX_FAILURES = 5;
const TOTP_FAILURE_WINDOW_MS = 5 * 60_000;
const OTP_ISSUER = 'AARADHYA WMS';

const totpFailures = new Map<string, { count: number; resetAt: number }>();

export function resetOtpRateLimitsForTests(): void {
  totpFailures.clear();
}

function audit(
  db: DB,
  eventType: string,
  user: AuthUser,
  outcome: 'SUCCESS' | 'FAILURE',
  options: { reason?: string | null; refs?: unknown; context?: SecurityContext } = {},
): void {
  recordAudit(db, {
    eventType,
    entityType: 'USER_SECURITY',
    entityId: user.id,
    outcome,
    reason: options.reason ?? null,
    refs: options.refs,
    actor: {
      userId: user.id,
      role: user.role,
      ip: options.context?.ip ?? null,
      userAgent: options.context?.userAgent ?? null,
      correlationId: options.context?.correlationId ?? null,
    },
  });
}

export function reportOtpRequired(db: DB): boolean {
  return getSetting<boolean>(db, 'report_otp_required', false) === true;
}

export function isTotpEnrolled(db: DB, userId: string): boolean {
  const row = db.prepare('SELECT confirmed_at FROM user_totp WHERE user_id = ?').get(userId) as
    | { confirmed_at: string | null }
    | undefined;
  return Boolean(row?.confirmed_at);
}

export function securityStatus(db: DB, user: AuthUser, sender: EmailSender) {
  const row = db
    .prepare('SELECT confirmed_at, created_at, updated_at FROM user_totp WHERE user_id = ?')
    .get(user.id) as { confirmed_at: string | null; created_at: string; updated_at: string } | undefined;
  const branding = getBranding(db);
  return {
    totp: {
      started: Boolean(row),
      enrolled: Boolean(row?.confirmed_at),
      confirmedAt: row?.confirmed_at ?? null,
    },
    email: {
      configured: sender.isConfigured(),
      from: sender.fromAddress(),
    },
    policy: {
      reportOtpRequired: reportOtpRequired(db),
    },
    branding: {
      template: branding.template,
      companyName: branding.companyName,
    },
  };
}

export async function startTotpEnrollment(
  db: DB,
  user: AuthUser,
  context: SecurityContext,
): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string; issuer: string; account: string }> {
  const existing = db
    .prepare('SELECT confirmed_at FROM user_totp WHERE user_id = ?')
    .get(user.id) as { confirmed_at: string | null } | undefined;
  if (existing?.confirmed_at) {
    throw conflict('TOTP_ALREADY_ENROLLED', 'An authenticator is already enrolled. Disable it before enrolling again.');
  }
  const secret = generateTotpSecret();
  const uri = otpauthUri({ secret, account: user.email, issuer: OTP_ISSUER });
  const now = nowIso();
  db.prepare(
    `INSERT INTO user_totp (user_id, secret_encrypted, confirmed_at, last_used_step, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET secret_encrypted = excluded.secret_encrypted,
       confirmed_at = NULL, last_used_step = NULL, updated_at = excluded.updated_at`,
  ).run(user.id, encryptSecret(secret), now, now);
  audit(db, 'TOTP_ENROLLMENT_STARTED', user, 'SUCCESS', { context });
  const qrDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 260,
    color: { dark: '#111827', light: '#ffffff' },
  });
  return { secret, otpauthUri: uri, qrDataUrl, issuer: OTP_ISSUER, account: user.email };
}

function totpSecret(db: DB, userId: string): string | null {
  const row = db.prepare('SELECT secret_encrypted FROM user_totp WHERE user_id = ?').get(userId) as
    | { secret_encrypted: string }
    | undefined;
  return row ? decryptSecret(row.secret_encrypted) : null;
}

function assertTotpAllowed(userId: string): void {
  const entry = totpFailures.get(userId);
  if (entry && entry.resetAt > Date.now() && entry.count >= TOTP_MAX_FAILURES) {
    throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many incorrect codes. Try again in a few minutes.', {
      retryAt: new Date(entry.resetAt).toISOString(),
    });
  }
}

function recordTotpFailure(userId: string): void {
  const now = Date.now();
  const entry = totpFailures.get(userId);
  if (!entry || entry.resetAt <= now) totpFailures.set(userId, { count: 1, resetAt: now + TOTP_FAILURE_WINDOW_MS });
  else entry.count += 1;
}

export function confirmTotpEnrollment(
  db: DB,
  user: AuthUser,
  code: string,
  context: SecurityContext,
): { enrolled: boolean; confirmedAt: string } {
  const row = db
    .prepare('SELECT confirmed_at, secret_encrypted FROM user_totp WHERE user_id = ?')
    .get(user.id) as { confirmed_at: string | null; secret_encrypted: string } | undefined;
  if (!row) throw badRequest('TOTP_NOT_STARTED', 'Start authenticator enrollment first');
  if (row.confirmed_at) throw conflict('TOTP_ALREADY_ENROLLED', 'This authenticator is already confirmed');
  assertTotpAllowed(user.id);
  const matchedStep = verifyTotp(decryptSecret(row.secret_encrypted), code);
  if (matchedStep === null) {
    recordTotpFailure(user.id);
    audit(db, 'TOTP_CONFIRM_FAILED', user, 'FAILURE', { reason: 'Invalid code', context });
    throw badRequest('OTP_INVALID', 'That code is not valid. Check the authenticator clock and try again.');
  }
  const now = nowIso();
  db.prepare('UPDATE user_totp SET confirmed_at = ?, last_used_step = ?, updated_at = ? WHERE user_id = ?').run(
    now,
    matchedStep,
    now,
    user.id,
  );
  totpFailures.delete(user.id);
  audit(db, 'TOTP_CONFIRMED', user, 'SUCCESS', { context });
  return { enrolled: true, confirmedAt: now };
}

export function disableTotp(
  db: DB,
  user: AuthUser,
  password: string,
  sender: EmailSender,
  context: SecurityContext,
): { disabled: boolean } {
  const row = db
    .prepare('SELECT u.password_hash, t.confirmed_at FROM users u LEFT JOIN user_totp t ON t.user_id = u.id WHERE u.id = ?')
    .get(user.id) as { password_hash: string; confirmed_at: string | null } | undefined;
  if (!row?.confirmed_at) throw notFound('No authenticator is enrolled for this account');
  if (!verifyPassword(password, row.password_hash)) {
    audit(db, 'TOTP_DISABLE_FAILED', user, 'FAILURE', { reason: 'Password verification failed', context });
    throw badRequest('PASSWORD_INVALID', 'Password is incorrect');
  }
  if (reportOtpRequired(db) && !sender.isConfigured()) {
    throw conflict(
      'TOTP_REQUIRED_BY_POLICY',
      'Report OTP is mandatory and email delivery is not configured. Keep the authenticator or enable SMTP first.',
    );
  }
  db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(user.id);
  totpFailures.delete(user.id);
  audit(db, 'TOTP_DISABLED', user, 'SUCCESS', { context });
  return { disabled: true };
}

export async function sendEmailOtp(
  db: DB,
  user: AuthUser,
  sender: EmailSender,
  context: SecurityContext,
): Promise<{ sent: boolean; channel: 'EMAIL'; sentTo: string; expiresAt: string; attemptsAllowed: number }> {
  if (!sender.isConfigured()) {
    throw new AppError(
      503,
      'EMAIL_OTP_UNAVAILABLE',
      'Email OTP is not configured on this server. Use an authenticator app or ask an administrator to configure SMTP.',
    );
  }
  const now = Date.now();
  const windowStart = new Date(now - EMAIL_OTP_WINDOW_MS).toISOString();
  const recent = db
    .prepare(
      "SELECT created_at FROM report_otp_challenges WHERE user_id = ? AND channel = 'EMAIL' AND created_at >= ? ORDER BY created_at ASC",
    )
    .all(user.id, windowStart) as Array<{ created_at: string }>;
  if (recent.length >= EMAIL_OTP_MAX_PER_WINDOW) {
    const retryAt = new Date(Date.parse(String(recent[0].created_at)) + EMAIL_OTP_WINDOW_MS).toISOString();
    throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many codes requested. Try again shortly.', { retryAt });
  }

  const cutoff = new Date(now - 24 * 3600_000).toISOString();
  db.prepare(
    'DELETE FROM report_otp_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)',
  ).run(cutoff, cutoff);

  const challengeId = newId();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(now + EMAIL_OTP_TTL_MS).toISOString();
  const sentTo = maskEmail(user.email);
  db.prepare(
    `INSERT INTO report_otp_challenges
       (id, user_id, channel, purpose, code_hash, expires_at, attempts, max_attempts, consumed_at, sent_to, created_at)
     VALUES (?, ?, 'EMAIL', 'REPORT_EXPORT', ?, ?, 0, ?, NULL, ?, ?)`,
  ).run(challengeId, user.id, hmacDigest(`${challengeId}:${user.id}`, code), expiresAt, EMAIL_OTP_MAX_ATTEMPTS, sentTo, nowIso());

  const companyName = String(getSetting(db, 'company_name', 'Aaradhya WMS'));
  const safeCompany = escapeHtml(companyName);
  try {
    await sender.send({
      to: user.email,
      subject: `${companyName} report verification code`,
      text: [
        `Hello ${user.name},`,
        '',
        `Your report verification code is ${code}.`,
        `It expires in 5 minutes. You have ${EMAIL_OTP_MAX_ATTEMPTS} attempts.`,
        '',
        'If you did not request this code, ignore this email and review your account activity.',
        'Never share this code with anyone.',
        '',
        companyName,
      ].join('\n'),
      html: `<div style="font-family:Arial,sans-serif;color:#0f172a;max-width:520px">
  <h2 style="margin:0 0 12px">${safeCompany}</h2>
  <p style="margin:0 0 8px">Hello ${escapeHtml(user.name)},</p>
  <p style="margin:0 0 8px">Your report verification code is:</p>
  <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:12px 0;color:#0f766e">${code}</p>
  <p style="margin:0 0 8px">It expires in 5 minutes. You have ${EMAIL_OTP_MAX_ATTEMPTS} attempts.</p>
  <p style="margin:16px 0 0;color:#475569;font-size:13px">If you did not request this code, ignore this email. Never share this code with anyone.</p>
</div>`,
    });
  } catch (error) {
    db.prepare('DELETE FROM report_otp_challenges WHERE id = ?').run(challengeId);
    audit(db, 'OTP_EMAIL_FAILED', user, 'FAILURE', {
      reason: error instanceof AppError ? error.code : 'EMAIL_SEND_FAILED',
      refs: { challengeId },
      context,
    });
    throw error;
  }
  audit(db, 'OTP_EMAIL_SENT', user, 'SUCCESS', {
    refs: { challengeId, sentTo, expiresAt },
    context,
  });
  return { sent: true, channel: 'EMAIL', sentTo, expiresAt, attemptsAllowed: EMAIL_OTP_MAX_ATTEMPTS };
}

function verifyEmailOtp(db: DB, user: AuthUser, code: string, context: SecurityContext): void {
  const challenge = db
    .prepare(
      `SELECT id, code_hash, expires_at, attempts, max_attempts, consumed_at
         FROM report_otp_challenges
        WHERE user_id = ? AND channel = 'EMAIL' AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(user.id) as
    | { id: string; code_hash: string; expires_at: string; attempts: number; max_attempts: number; consumed_at: string | null }
    | undefined;
  const now = nowIso();
  if (!challenge || String(challenge.expires_at) <= now) {
    audit(db, 'REPORT_OTP_FAILED', user, 'FAILURE', { reason: 'Email code expired or was not requested', refs: { channel: 'EMAIL' }, context });
    throw badRequest('OTP_EXPIRED', 'The email code expired. Request a new code.');
  }
  if (Number(challenge.attempts) >= Number(challenge.max_attempts)) {
    audit(db, 'REPORT_OTP_FAILED', user, 'FAILURE', { reason: 'Attempt limit reached', refs: { channel: 'EMAIL', challengeId: challenge.id }, context });
    throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
  }
  const expected = hmacDigest(`${challenge.id}:${user.id}`, code);
  const supplied = Buffer.from(expected);
  const stored = Buffer.from(String(challenge.code_hash));
  const matches = supplied.length === stored.length && timingSafeEqual(supplied, stored);
  if (!matches) {
    const attempts = Number(challenge.attempts) + 1;
    db.prepare('UPDATE report_otp_challenges SET attempts = ? WHERE id = ?').run(attempts, challenge.id);
    audit(db, 'REPORT_OTP_FAILED', user, 'FAILURE', {
      reason: 'Incorrect email code',
      refs: { channel: 'EMAIL', challengeId: challenge.id, attempts },
      context,
    });
    if (attempts >= Number(challenge.max_attempts)) {
      throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');
    }
    throw badRequest('OTP_INVALID', 'That code is not valid.', {
      remainingAttempts: Number(challenge.max_attempts) - attempts,
    });
  }
  db.prepare('UPDATE report_otp_challenges SET consumed_at = ? WHERE id = ?').run(now, challenge.id);
  audit(db, 'REPORT_OTP_VERIFIED', user, 'SUCCESS', { refs: { channel: 'EMAIL', challengeId: challenge.id }, context });
}

function verifyTotpCode(db: DB, user: AuthUser, code: string, context: SecurityContext): void {
  const row = db
    .prepare('SELECT secret_encrypted, confirmed_at, last_used_step FROM user_totp WHERE user_id = ?')
    .get(user.id) as { secret_encrypted: string; confirmed_at: string | null; last_used_step: number | null } | undefined;
  if (!row?.confirmed_at) {
    throw conflict('TOTP_NOT_ENROLLED', 'Enroll an authenticator app before using TOTP for reports.');
  }
  assertTotpAllowed(user.id);
  const matched = verifyTotp(decryptSecret(row.secret_encrypted), code);
  if (matched === null) {
    recordTotpFailure(user.id);
    audit(db, 'REPORT_OTP_FAILED', user, 'FAILURE', { reason: 'Incorrect authenticator code', refs: { channel: 'TOTP' }, context });
    throw badRequest('OTP_INVALID', 'That authenticator code is not valid.');
  }
  if (row.last_used_step !== null && matched <= Number(row.last_used_step)) {
    audit(db, 'REPORT_OTP_FAILED', user, 'FAILURE', { reason: 'Authenticator code replayed', refs: { channel: 'TOTP', step: matched }, context });
    throw badRequest('OTP_REPLAYED', 'That code was already used. Wait for the next code.');
  }
  db.prepare('UPDATE user_totp SET last_used_step = ?, updated_at = ? WHERE user_id = ?').run(matched, nowIso(), user.id);
  totpFailures.delete(user.id);
  audit(db, 'REPORT_OTP_VERIFIED', user, 'SUCCESS', { refs: { channel: 'TOTP', step: matched }, context });
}

export function verifyReportOtp(
  db: DB,
  user: AuthUser,
  otp: { channel: OtpChannel; code: string },
  context: SecurityContext,
): void {
  const normalized = otp.code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(normalized)) throw badRequest('OTP_INVALID', 'Enter the 6-digit security code.');
  if (otp.channel === 'EMAIL') verifyEmailOtp(db, user, normalized, context);
  else verifyTotpCode(db, user, normalized, context);
}

export async function sendTestEmail(
  db: DB,
  user: AuthUser,
  sender: EmailSender,
  context: SecurityContext,
): Promise<{ sentTo: string }> {
  if (!sender.isConfigured()) {
    throw new AppError(503, 'EMAIL_OTP_UNAVAILABLE', 'SMTP is not configured. Set SMTP_HOST and SMTP_FROM on the server.');
  }
  const companyName = String(getSetting(db, 'company_name', 'Aaradhya WMS'));
  const sentTo = maskEmail(user.email);
  try {
    await sender.send({
      to: user.email,
      subject: `${companyName} email delivery test`,
      text: `This is a delivery test from ${companyName}. Report OTP emails will be sent to this address.`,
      html: `<p>This is a delivery test from <strong>${escapeHtml(companyName)}</strong>.</p><p>Report OTP emails will be sent to this address.</p>`,
    });
  } catch (error) {
    audit(db, 'OTP_TEST_EMAIL_FAILED', user, 'FAILURE', {
      reason: error instanceof AppError ? error.code : 'EMAIL_SEND_FAILED',
      context,
    });
    throw error;
  }
  audit(db, 'OTP_TEST_EMAIL_SENT', user, 'SUCCESS', { refs: { sentTo }, context });
  return { sentTo };
}

function brandingRow(db: DB) {
  return db.prepare('SELECT * FROM report_branding WHERE id = ?').get('default') as
    | Record<string, unknown>
    | undefined;
}

export function getBranding(db: DB): ReportBranding {
  const row = brandingRow(db);
  const companyName = String(getSetting(db, 'company_name', 'Aaradhya Homeopathic Pvt. Ltd.'));
  return {
    companyName,
    tagline: row?.tagline == null ? null : String(row.tagline),
    addressLine: row?.address_line == null ? null : String(row.address_line),
    contactLine: row?.contact_line == null ? null : String(row.contact_line),
    logoDataUrl: row?.logo_data_url == null ? null : String(row.logo_data_url),
    logoMime: row?.logo_mime === 'image/png' ? 'image/png' : row?.logo_mime === 'image/jpeg' ? 'image/jpeg' : null,
    watermarkText: row?.watermark_text == null ? null : String(row.watermark_text),
    watermarkOpacity: row?.watermark_opacity == null ? 0.08 : Number(row.watermark_opacity),
    footerNote: row?.footer_note == null ? null : String(row.footer_note),
    template: REPORT_TEMPLATES.includes(row?.template as ReportTemplate)
      ? (row?.template as ReportTemplate)
      : 'EXECUTIVE',
    primaryColor: row?.primary_color == null ? '#0F766E' : String(row.primary_color),
    accentColor: row?.accent_color == null ? '#F59E0B' : String(row.accent_color),
    updatedAt: row?.updated_at == null ? null : String(row.updated_at),
  };
}

export function decodeLogo(dataUrl: string): { dataUrl: string; mime: 'image/png' | 'image/jpeg'; bytes: number } {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) throw badRequest('LOGO_INVALID', 'The logo must be a PNG or JPEG image encoded as a data URL');
  const mime = match[1] === 'png' ? 'image/png' : 'image/jpeg';
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) {
    throw badRequest('LOGO_INVALID', 'The logo must be smaller than 2 MB');
  }
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if ((mime === 'image/png' && !isPng) || (mime === 'image/jpeg' && !isJpeg)) {
    throw badRequest('LOGO_INVALID', 'The logo file does not match its declared image type');
  }
  return { dataUrl: `data:${mime};base64,${match[2]}`, mime, bytes: buffer.length };
}

function auditBranding(branding: ReportBranding) {
  return {
    companyName: branding.companyName,
    tagline: branding.tagline,
    addressLine: branding.addressLine,
    contactLine: branding.contactLine,
    watermarkText: branding.watermarkText,
    watermarkOpacity: branding.watermarkOpacity,
    footerNote: branding.footerNote,
    template: branding.template,
    primaryColor: branding.primaryColor,
    accentColor: branding.accentColor,
    logo: branding.logoDataUrl ? { mime: branding.logoMime, bytes: Math.ceil((branding.logoDataUrl.length * 3) / 4) } : null,
  };
}

export function updateBranding(
  db: DB,
  input: BrandingInput,
  user: AuthUser,
  context: SecurityContext,
): ReportBranding {
  const companyName = input.companyName.trim();
  if (!companyName) throw badRequest('BRANDING_INVALID', 'Company name is required');
  if (!REPORT_TEMPLATES.includes(input.template)) throw badRequest('BRANDING_INVALID', 'Unknown report template');
  if (!/^#[0-9A-Fa-f]{6}$/.test(input.primaryColor) || !/^#[0-9A-Fa-f]{6}$/.test(input.accentColor)) {
    throw badRequest('BRANDING_INVALID', 'Colours must be 6-digit hex values');
  }
  if (!Number.isFinite(input.watermarkOpacity) || input.watermarkOpacity < 0 || input.watermarkOpacity > 0.5) {
    throw badRequest('BRANDING_INVALID', 'Watermark opacity must be between 0 and 0.5');
  }
  const logo = input.logoDataUrl ? decodeLogo(input.logoDataUrl) : null;
  const before = getBranding(db);
  const now = nowIso();
  return withTransaction(db, () => {
    if (before.companyName !== companyName) {
      updateSetting(db, 'company_name', companyName, user);
    }
    db.prepare(
      `INSERT INTO report_branding
         (id, tagline, address_line, contact_line, logo_data_url, logo_mime, watermark_text,
          watermark_opacity, footer_note, template, primary_color, accent_color, updated_by, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         tagline = excluded.tagline,
         address_line = excluded.address_line,
         contact_line = excluded.contact_line,
         logo_data_url = excluded.logo_data_url,
         logo_mime = excluded.logo_mime,
         watermark_text = excluded.watermark_text,
         watermark_opacity = excluded.watermark_opacity,
         footer_note = excluded.footer_note,
         template = excluded.template,
         primary_color = excluded.primary_color,
         accent_color = excluded.accent_color,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(
      input.tagline?.trim() || null,
      input.addressLine?.trim() || null,
      input.contactLine?.trim() || null,
      logo?.dataUrl ?? null,
      logo?.mime ?? null,
      input.watermarkText?.trim() || null,
      input.watermarkOpacity,
      input.footerNote?.trim() || null,
      input.template,
      input.primaryColor.toUpperCase(),
      input.accentColor.toUpperCase(),
      user.id,
      now,
    );
    const after = getBranding(db);
    recordAudit(db, {
      eventType: 'REPORT_BRANDING_UPDATED',
      entityType: 'REPORT_BRANDING',
      entityId: 'default',
      before: auditBranding(before),
      after: auditBranding(after),
      refs: { logoChanged: Boolean(logo), logoBytes: logo?.bytes ?? null },
      actor: {
        userId: user.id,
        role: user.role,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId ?? null,
      },
    });
    return after;
  });
}
