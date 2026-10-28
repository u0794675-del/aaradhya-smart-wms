UPDATE notifications
   SET status = 'RESOLVED'
 WHERE dedupe_key IS NOT NULL
   AND status IN ('OPEN', 'ACKNOWLEDGED')
   AND id NOT IN (
     SELECT id FROM (
       SELECT id,
              ROW_NUMBER() OVER (PARTITION BY dedupe_key ORDER BY created_at, id) AS row_rank
         FROM notifications
        WHERE dedupe_key IS NOT NULL
          AND status IN ('OPEN', 'ACKNOWLEDGED')
     ) ranked
      WHERE row_rank = 1
   );

DROP INDEX IF EXISTS ux_notifications_open_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_unresolved_dedupe
  ON notifications(dedupe_key) WHERE status IN ('OPEN', 'ACKNOWLEDGED');
