import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config.ts';
import { AppError } from '../lib/errors.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly name: string;
  isConfigured(): boolean;
  fromAddress(): string | null;
  send(message: EmailMessage): Promise<void>;
}

class SmtpEmailSender implements EmailSender {
  readonly name = 'SMTP';
  private transporter: Transporter | null = null;

  isConfigured(): boolean {
    return Boolean(config.smtp.host && (config.smtp.from || config.smtp.user));
  }

  fromAddress(): string | null {
    return config.smtp.from || config.smtp.user || null;
  }

  private getTransporter(): Transporter {
    if (!this.isConfigured()) {
      throw new AppError(
        503,
        'EMAIL_OTP_UNAVAILABLE',
        'Email delivery is not configured. Ask an administrator to set the SMTP environment variables.',
      );
    }
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth:
          config.smtp.user && config.smtp.password
            ? { user: config.smtp.user, pass: config.smtp.password }
            : undefined,
        tls: { rejectUnauthorized: config.smtp.tlsRejectUnauthorized },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<void> {
    const transporter = this.getTransporter();
    try {
      await transporter.sendMail({
        from: this.fromAddress() ?? undefined,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch {
      // SMTP errors can echo credentials or internal hostnames; keep them out of the API and logs.
      throw new AppError(502, 'EMAIL_SEND_FAILED', 'The email could not be delivered. Check the SMTP configuration.');
    }
  }
}

export function createEmailSender(): EmailSender {
  return new SmtpEmailSender();
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
