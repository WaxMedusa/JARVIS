import crypto from 'node:crypto';
import type {JarvisDB} from '../db/database.js';
import {redactDeep, truncateMiddle} from '../core/redact.js';

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  detail: string | null;
  hash: string;
  prev_hash: string;
}

/**
 * Append-only, hash-chained audit log. Each row commits to the previous hash,
 * so silent tampering is detectable with `verify()`.
 */
export class AuditLog {
  private readonly db: JarvisDB;
  private readonly enabled: boolean;

  constructor(db: JarvisDB, enabled = true) {
    this.db = db;
    this.enabled = enabled;
  }

  record(actor: string, action: string, detail?: unknown): void {
    if (!this.enabled) return;
    const ts = new Date().toISOString();
    const serialized =
      detail === undefined
        ? null
        : truncateMiddle(
            JSON.stringify(redactDeep(detail), (_key, value) => (typeof value === 'bigint' ? Number(value) : value)),
            4000,
          );
    const last = this.db.get<{hash: string}>(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`);
    const prevHash = last?.hash ?? 'genesis';
    const hash = crypto
      .createHash('sha256')
      .update(`${prevHash}|${ts}|${actor}|${action}|${serialized ?? ''}`)
      .digest('hex');
    this.db.run(
      `INSERT INTO audit_log(ts, actor, action, detail, hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?)`,
      ts,
      actor,
      action,
      serialized,
      hash,
      prevHash,
    );
  }

  tail(limit = 50): AuditEntry[] {
    return this.db.all<AuditEntry>(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`, Math.min(Math.max(limit, 1), 1000));
  }

  count(): number {
    return this.db.tableCount('audit_log');
  }

  verify(limit = 5000): {ok: boolean; checked: number; brokenAt?: number; reason?: string} {
    const rows = this.db.all<AuditEntry>(`SELECT * FROM audit_log ORDER BY id ASC LIMIT ?`, limit);
    let prev = 'genesis';
    for (const row of rows) {
      const expected = crypto
        .createHash('sha256')
        .update(`${prev}|${row.ts}|${row.actor}|${row.action}|${row.detail ?? ''}`)
        .digest('hex');
      if (row.prev_hash !== prev || row.hash !== expected) {
        return {ok: false, checked: rows.length, brokenAt: row.id, reason: 'hash chain mismatch'};
      }
      prev = row.hash;
    }
    return {ok: true, checked: rows.length};
  }
}
