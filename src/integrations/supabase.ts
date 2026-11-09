import {fetchCapped} from '../core/http.js';
import {JarvisError} from '../core/errors.js';
import {nowIso} from '../core/time.js';
import type {JarvisDB} from '../db/database.js';
import type {SupabaseService} from './types.js';

interface SupabaseOptions {
  url: string;
  key: string;
  tablePrefix: string;
  db: JarvisDB;
}

const TABLES = ['memories', 'profile_facts', 'tasks'] as const;

/** Single-user cloud mirror using Supabase's REST API (service-role key). */
export class SupabaseClient implements SupabaseService {
  private readonly options: SupabaseOptions;

  constructor(options: SupabaseOptions) {
    this.options = options;
  }

  static create(options: SupabaseOptions): SupabaseClient | null {
    return options.url && options.key ? new SupabaseClient(options) : null;
  }

  private table(name: string): string {
    return `${this.options.tablePrefix}${name}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = this.options.url.replace(/\/+$/, '');
    const response = await fetchCapped(`${base}/rest/v1/${path}`, {
      ...init,
      timeoutMs: 45_000,
      headers: {
        apikey: this.options.key,
        authorization: `Bearer ${this.options.key}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
        ...(init.headers ?? {}),
      },
      service: 'Supabase',
      maxBytes: 8 * 1024 * 1024,
    });
    if (!response.text.trim()) return {} as T;
    try {
      return JSON.parse(response.text) as T;
    } catch {
      return {} as T;
    }
  }

  async status(): Promise<{configured: boolean; reachable: boolean; detail: string}> {
    try {
      await this.request(`${this.table('memories')}?select=id&limit=1`);
      return {configured: true, reachable: true, detail: 'connected'};
    } catch (error) {
      return {configured: true, reachable: false, detail: (error as Error).message};
    }
  }

  async push(): Promise<{pushed: number; tables: string[]}> {
    const pushedTables: string[] = [];
    let pushed = 0;
    const memories = this.options.db.all<Record<string, unknown>>(
      `SELECT id, content, kind, source, source_ref, importance, sensitivity, pinned, hash, access_count, last_accessed_at, expires_at, created_at, updated_at FROM memories`,
    );
    pushed += await this.upsert('memories', memories);
    pushedTables.push(`memories:${memories.length}`);

    const facts = this.options.db.all<Record<string, unknown>>(
      `SELECT id, key, value, category, confidence, source, sensitivity, created_at, updated_at, last_confirmed_at, superseded_by FROM profile_facts`,
    );
    pushed += await this.upsert('profile_facts', facts);
    pushedTables.push(`profile_facts:${facts.length}`);

    const tasks = this.options.db.all<Record<string, unknown>>(
      `SELECT id, title, notes, due_at, recurrence, priority, status, channel, notified_at, source, created_at, completed_at FROM tasks`,
    );
    pushed += await this.upsert('tasks', tasks);
    pushedTables.push(`tasks:${tasks.length}`);

    this.setSyncState('push');
    return {pushed, tables: pushedTables};
  }

  private async upsert(table: string, rows: Array<Record<string, unknown>>): Promise<number> {
    let count = 0;
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      if (!batch.length) continue;
      await this.request(`${this.table(table)}?on_conflict=id`, {
        method: 'POST',
        headers: {prefer: 'resolution=merge-duplicates,return=minimal'},
        body: JSON.stringify(batch),
      });
      count += batch.length;
    }
    return count;
  }

  async pull(): Promise<{pulled: number}> {
    const last = this.options.db.get<{last_pulled_at: string | null}>('SELECT last_pulled_at FROM sync_state WHERE entity = ?', 'pull');
    const since = last?.last_pulled_at ?? '1970-01-01T00:00:00.000Z';
    let pulled = 0;

    const memories = await this.request<Array<Record<string, unknown>>>(
      `${this.table('memories')}?select=*&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.asc&limit=1000`,
    );
    for (const row of memories) pulled += this.mergeMemory(row);

    const facts = await this.request<Array<Record<string, unknown>>>(
      `${this.table('profile_facts')}?select=*&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.asc&limit=1000`,
    );
    for (const row of facts) pulled += this.mergeFact(row);

    const tasks = await this.request<Array<Record<string, unknown>>>(
      `${this.table('tasks')}?select=*&updated_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=1000`,
    );
    for (const row of tasks) pulled += this.mergeTask(row);

    this.setSyncState('pull');
    return {pulled};
  }

  private mergeMemory(row: Record<string, unknown>): number {
    const id = String(row.id ?? '');
    if (!id) return 0;
    const remoteUpdated = String(row.updated_at ?? nowIso());
    const local = this.options.db.get<{updated_at: string}>('SELECT updated_at FROM memories WHERE id = ?', id);
    if (local && Date.parse(local.updated_at) >= Date.parse(remoteUpdated)) return 0;
    if (local) {
      this.options.db.run(
        `UPDATE memories SET content=?, kind=?, source=?, source_ref=?, importance=?, sensitivity=?, pinned=?, hash=?, created_at=?, updated_at=?, expires_at=? WHERE id=?`,
        String(row.content ?? ''),
        String(row.kind ?? 'note'),
        String(row.source ?? 'supabase'),
        row.source_ref ? String(row.source_ref) : null,
        Number(row.importance ?? 0.5),
        String(row.sensitivity ?? 'private'),
        Number(row.pinned ?? 0),
        row.hash ? String(row.hash) : null,
        String(row.created_at ?? remoteUpdated),
        remoteUpdated,
        row.expires_at ? String(row.expires_at) : null,
        id,
      );
    } else {
      this.options.db.run(
        `INSERT INTO memories(id, content, kind, source, source_ref, importance, sensitivity, pinned, hash, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        String(row.content ?? ''),
        String(row.kind ?? 'note'),
        String(row.source ?? 'supabase'),
        row.source_ref ? String(row.source_ref) : null,
        Number(row.importance ?? 0.5),
        String(row.sensitivity ?? 'private'),
        Number(row.pinned ?? 0),
        row.hash ? String(row.hash) : null,
        String(row.created_at ?? remoteUpdated),
        remoteUpdated,
        row.expires_at ? String(row.expires_at) : null,
      );
    }
    return 1;
  }

  private mergeFact(row: Record<string, unknown>): number {
    const id = String(row.id ?? '');
    const key = String(row.key ?? '');
    if (!id || !key) return 0;
    const remoteUpdated = String(row.updated_at ?? nowIso());
    const local = this.options.db.get<{updated_at: string}>('SELECT updated_at FROM profile_facts WHERE id = ?', id);
    if (local && Date.parse(local.updated_at) >= Date.parse(remoteUpdated)) return 0;

    const supersededBy = row.superseded_by ? String(row.superseded_by) : null;
    if (!supersededBy) {
      const active = this.options.db.get<{id: string; updated_at: string}>(
        'SELECT id, updated_at FROM profile_facts WHERE key = ? AND superseded_by IS NULL',
        key,
      );
      if (active && active.id !== id) {
        if (Date.parse(active.updated_at) > Date.parse(remoteUpdated)) return 0;
        this.options.db.run('UPDATE profile_facts SET superseded_by = ? WHERE id = ?', id, active.id);
      }
    }

    if (local) {
      this.options.db.run(
        `UPDATE profile_facts SET key=?, value=?, category=?, confidence=?, source=?, sensitivity=?, updated_at=?, last_confirmed_at=?, superseded_by=? WHERE id=?`,
        key,
        String(row.value ?? ''),
        String(row.category ?? 'general'),
        Number(row.confidence ?? 0.7),
        row.source ? String(row.source) : null,
        String(row.sensitivity ?? 'private'),
        remoteUpdated,
        row.last_confirmed_at ? String(row.last_confirmed_at) : null,
        supersededBy,
        id,
      );
    } else {
      this.options.db.run(
        `INSERT INTO profile_facts(id, key, value, category, confidence, source, sensitivity, created_at, updated_at, last_confirmed_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        key,
        String(row.value ?? ''),
        String(row.category ?? 'general'),
        Number(row.confidence ?? 0.7),
        row.source ? String(row.source) : null,
        String(row.sensitivity ?? 'private'),
        String(row.created_at ?? remoteUpdated),
        remoteUpdated,
        row.last_confirmed_at ? String(row.last_confirmed_at) : null,
        supersededBy,
      );
    }
    return 1;
  }

  private mergeTask(row: Record<string, unknown>): number {
    const id = String(row.id ?? '');
    if (!id) return 0;
    const local = this.options.db.get<{updated_at?: string}>('SELECT id FROM tasks WHERE id = ?', id);
    if (local) return 0;
    this.options.db.run(
      `INSERT INTO tasks(id, title, notes, due_at, recurrence, priority, status, channel, notified_at, source, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      String(row.title ?? '(untitled)'),
      row.notes ? String(row.notes) : null,
      row.due_at ? String(row.due_at) : null,
      row.recurrence ? String(row.recurrence) : null,
      Number(row.priority ?? 2),
      String(row.status ?? 'open'),
      row.channel ? String(row.channel) : null,
      row.notified_at ? String(row.notified_at) : null,
      row.source ? String(row.source) : 'supabase',
      String(row.created_at ?? nowIso()),
      row.completed_at ? String(row.completed_at) : null,
    );
    return 1;
  }

  private setSyncState(direction: 'push' | 'pull'): void {
    const timestamp = nowIso();
    this.options.db.run(
      `INSERT INTO sync_state(entity, last_pushed_at, last_pulled_at) VALUES ('pull', ?, ?)
       ON CONFLICT(entity) DO UPDATE SET last_pushed_at = COALESCE(excluded.last_pushed_at, sync_state.last_pushed_at), last_pulled_at = excluded.last_pulled_at`,
      direction === 'push' ? timestamp : null,
      direction === 'pull' ? timestamp : null,
    );
    if (direction === 'push') {
      this.options.db.run(
        `INSERT INTO sync_state(entity, last_pushed_at) VALUES ('push', ?)
         ON CONFLICT(entity) DO UPDATE SET last_pushed_at = excluded.last_pushed_at`,
        timestamp,
      );
    }
  }
}

export const SUPABASE_TABLES = TABLES;
