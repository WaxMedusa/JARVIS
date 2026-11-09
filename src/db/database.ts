import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {JarvisError} from '../core/errors.js';
import {getLogger} from '../core/logger.js';
import {LATEST_VERSION, MIGRATIONS} from './migrations.js';

export type SqlValue = string | number | null | Uint8Array | boolean | undefined | Date;

function normalize(value: SqlValue): string | number | null | Uint8Array {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class JarvisDB {
  readonly path: string;
  private db: DatabaseSync;
  private closed = false;
  private txDepth = 0;

  constructor(filePath: string) {
    this.path = filePath;
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), {recursive: true});
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`);
    const appliedRows = this.db.prepare('SELECT version FROM _migrations').all() as Array<{version: number}>;
    const applied = new Set(appliedRows.map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const started = Date.now();
      this.transaction(() => {
        // sqlite3_exec understands multi-statement scripts, including trigger bodies.
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO _migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      });
      getLogger().debug('applied migration', {version: migration.version, name: migration.name, ms: Date.now() - started});
    }
    const current = this.get<{version: number}>('SELECT MAX(version) AS version FROM _migrations');
    if ((current?.version ?? 0) < LATEST_VERSION) {
      throw new JarvisError('INTERNAL', `Database schema is behind (${current?.version ?? 0} < ${LATEST_VERSION})`);
    }
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    return statement.get(...params.map(normalize)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    return statement.all(...params.map(normalize)) as T[];
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    const result = statement.run(...params.map(normalize));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  /** Immediate transaction; supports nesting through savepoints. */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.db.exec('BEGIN IMMEDIATE');
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (depth === 0) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.txDepth -= 1;
      try {
        if (depth === 0) this.db.exec('ROLLBACK');
        else this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  hasFts(): boolean {
    const row = this.get<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'");
    return Boolean(row);
  }

  kvGet(key: string): string | null {
    const row = this.get<{value: string | null}>('SELECT value FROM kv WHERE key = ?', key);
    return row?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.run(
      `INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
      new Date().toISOString(),
    );
  }

  kvDelete(key: string): void {
    this.run('DELETE FROM kv WHERE key = ?', key);
  }

  tableCount(table: string): number {
    if (!/^[a-z_]+$/.test(table)) throw new JarvisError('VALIDATION', `Invalid table name: ${table}`);
    const row = this.get<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(row?.n ?? 0);
  }

  integrityCheck(): {ok: boolean; issues: string[]} {
    const rows = this.all<{integrity_check: string}>('PRAGMA integrity_check');
    const messages = rows.map((row) => String(row.integrity_check));
    return {ok: messages.length === 1 && messages[0] === 'ok', issues: messages.filter((m) => m !== 'ok')};
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // best effort
    }
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new JarvisError('INTERNAL', 'Database is closed');
  }
}

/** Split SQL on semicolons outside of string literals and trigger bodies. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (ch === "'") {
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === ';' && !inString) {
      statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current);
  return statements;
}
