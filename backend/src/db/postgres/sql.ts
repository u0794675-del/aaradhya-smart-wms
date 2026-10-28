/**
 * Translates the SQL subset used by the services (SQLite "?" bindings, case-insensitive
 * LIKE) into PostgreSQL syntax. Quoted literals, identifiers, comments and dollar-quoted
 * blocks are left untouched.
 */
export function translateQuery(sql: string): string {
  let out = '';
  let i = 0;
  let param = 0;
  let state: 'normal' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'normal';
  let dollarTag = '';

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (state === 'normal') {
      if (ch === "'") {
        state = 'single';
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = 'double';
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '-' && next === '-') {
        state = 'line';
        out += '--';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '/*';
        i += 2;
        continue;
      }
      if (ch === '$') {
        const match = /^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/.exec(sql.slice(i));
        if (match) {
          dollarTag = match[0];
          state = 'dollar';
          out += dollarTag;
          i += dollarTag.length;
          continue;
        }
      }
      if (ch === '?') {
        param += 1;
        out += `$${param}`;
        i += 1;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let end = i + 1;
        while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) end += 1;
        const word = sql.slice(i, end);
        out += word.toUpperCase() === 'LIKE' ? 'ILIKE' : word;
        i = end;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === 'single') {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'double') {
      out += ch;
      if (ch === '"' && next === '"') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'line') {
      out += ch;
      if (ch === '\n') state = 'normal';
      i += 1;
      continue;
    }

    if (state === 'block') {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i += 2;
        state = 'normal';
        continue;
      }
      i += 1;
      continue;
    }

    out += ch;
    if (sql.startsWith(dollarTag, i)) {
      out = out.slice(0, -1) + dollarTag;
      i += dollarTag.length;
      state = 'normal';
      continue;
    }
    i += 1;
  }

  return out;
}

export function translateExec(sql: string): string {
  if (/^BEGIN\s+IMMEDIATE\s*;?$/i.test(sql.trim())) return 'BEGIN';
  return translateQuery(sql);
}

export function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}
