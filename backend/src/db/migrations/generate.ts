const TRIGGER_RE =
  /CREATE TRIGGER IF NOT EXISTS (\w+)\s+BEFORE (UPDATE|DELETE) ON (\w+)\s+BEGIN\s+SELECT\s+RAISE\(ABORT,\s*'([^']*)'\);\s*END;/g;

/**
 * Converts the shared SQLite migration DDL into PostgreSQL DDL. Only trigger
 * definitions and the SQLite-only "IF NOT EXISTS" view form differ; everything
 * else is kept portable on purpose.
 */
export function toPostgresMigration(sql: string): string {
  const converted = sql
    .replace(TRIGGER_RE, (_match, name: string, action: string, table: string, message: string) => {
      const fn = `${name}_fn`;
      return `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '${message.replace(/'/g, "''")}';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ${name} ON ${table};
CREATE TRIGGER ${name} BEFORE ${action} ON ${table}
FOR EACH ROW EXECUTE FUNCTION ${fn}();`;
    })
    .replace(/CREATE VIEW IF NOT EXISTS (\w+) AS/g, 'DROP VIEW IF EXISTS $1;\nCREATE VIEW $1 AS');

  const unsupported = [
    ['trigger syntax', /CREATE TRIGGER IF NOT EXISTS/],
    ['rowid', /\browid\b/],
    ['strftime', /\bstrftime\s*\(/],
    ['INSERT OR IGNORE', /\bINSERT\s+OR\s+IGNORE\b/],
    ['AUTOINCREMENT', /\bAUTOINCREMENT\b/],
  ] as const;
  for (const [label, pattern] of unsupported) {
    if (pattern.test(converted)) {
      throw new Error(`PostgreSQL migration still contains SQLite-specific ${label}`);
    }
  }

  return converted;
}
