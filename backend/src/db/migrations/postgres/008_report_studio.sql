-- Report Studio: report branding, one-time codes for exports, and per-user
-- authenticator enrollment. OTP secrets and codes are stored as hashes or
-- ciphertext; the plaintext is never persisted.

CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,
  confirmed_at TEXT,
  last_used_step INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL','TOTP')),
  purpose TEXT NOT NULL CHECK (purpose IN ('REPORT_EXPORT')),
  code_hash TEXT,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  consumed_at TEXT,
  sent_to TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_report_otp_user ON report_otp_challenges(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_report_otp_expiry ON report_otp_challenges(expires_at);

CREATE TABLE IF NOT EXISTS report_branding (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  tagline TEXT,
  address_line TEXT,
  contact_line TEXT,
  logo_data_url TEXT,
  logo_mime TEXT,
  watermark_text TEXT,
  watermark_opacity REAL NOT NULL DEFAULT 0.08,
  footer_note TEXT,
  template TEXT NOT NULL DEFAULT 'EXECUTIVE' CHECK (template IN ('EXECUTIVE','CLASSIC','MINIMAL')),
  primary_color TEXT NOT NULL DEFAULT '#0F766E',
  accent_color TEXT NOT NULL DEFAULT '#F59E0B',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

INSERT INTO report_branding (id, tagline, watermark_text, watermark_opacity, footer_note, template, primary_color, accent_color)
VALUES ('default', 'B2B warehouse operations', 'AARADHYA', 0.08, 'Confidential - internal warehouse document', 'EXECUTIVE', '#0F766E', '#F59E0B')
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value_json, description)
VALUES ('report_otp_required', 'false', 'Require a one-time code before exporting a report')
ON CONFLICT DO NOTHING;

UPDATE permissions SET description = 'Export reports as PDF, Excel or CSV' WHERE code = 'report.export';
