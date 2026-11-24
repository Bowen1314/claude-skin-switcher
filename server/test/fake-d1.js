// A small D1 stand-in backed by node:sqlite, so tests run the real migration SQL.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

class FakeStatement {
  constructor(d1, sql, params = []) {
    this.d1 = d1;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    for (const p of params) {
      if (p === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${this.sql}`);
    }
    return new FakeStatement(this.d1, this.sql, params);
  }

  _exec() {
    const stmt = this.d1.db.prepare(this.sql);
    const results = stmt.all(...this.params).map((r) => ({ ...r }));
    const isRead = /^\s*SELECT\b/i.test(this.sql);
    const changes = isRead ? 0 : this.d1.db.prepare('SELECT changes() AS c').get().c;
    return { results, success: true, meta: { changes } };
  }

  async first(column) {
    const row = this._exec().results[0] ?? null;
    if (column === undefined) return row;
    return row === null ? null : (row[column] ?? null);
  }

  async all() {
    return this._exec();
  }

  async run() {
    return this._exec();
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
    }
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  raw(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
}
