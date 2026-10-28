CREATE TABLE IF NOT EXISTS notification_states (
  dedupe_key TEXT PRIMARY KEY,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO notification_states (dedupe_key, active, updated_at)
SELECT dedupe_key, 1, created_at
  FROM notifications
 WHERE dedupe_key IS NOT NULL
ON CONFLICT DO NOTHING;
