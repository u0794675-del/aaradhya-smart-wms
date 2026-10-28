import path from 'node:path';
import process from 'node:process';

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4173),
  dbDriver: (process.env.DB_DRIVER ?? 'sqlite') as 'sqlite' | 'postgres',
  dbPath: process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'wms.db'),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgSchema: process.env.PG_SCHEMA ?? 'public',
  timezone: process.env.WMS_TIMEZONE ?? 'Asia/Kolkata',
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  isProduction: process.env.NODE_ENV === 'production',
  frontendDist: process.env.FRONTEND_DIST ?? path.resolve(process.cwd(), '..', 'frontend', 'dist'),
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD ?? '',
  companyName: 'Aaradhya Homeopathic Pvt. Ltd.',
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT ?? 587) === 465,
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
    tlsRejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
  },
};
