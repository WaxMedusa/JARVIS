import crypto from 'node:crypto';
import type {JarvisConfig} from '../config.js';
import {nowIso} from '../core/time.js';
import {getLogger, type Logger} from '../core/logger.js';
import type {JarvisDB} from '../db/database.js';
import {newId} from '../core/ids.js';
import {blobToVector, cosine, normalizeVector, vectorToBlob, type Embedder} from '../llm/embeddings.js';
import type {EntityRecord, MemoryHit, MemoryRecord, ProfileFact, RememberInput, SearchOptions, SetFactInput} from './types.js';

const MAX_CONTENT_CHARS = 8000;

/**
 * Persistent memory: episodic memories (hybrid keyword + vector recall) and a
 * temporally-versioned user profile ("everything about me").
 */
export class MemoryService {
  private readonly db: JarvisDB;
  private readonly config: JarvisConfig;
  private readonly embedder: Embedder | null;
  private readonly logger: Logger;
  private insertCounter = 0;

  constructor(options: {db: JarvisDB; config: JarvisConfig; embedder?: Embedder | null}) {
    this.db = options.db;
    this.config = options.config;
    this.embedder = options.embedder ?? null;
    this.logger = getLogger().child('memory');
  }

  /* ---------------------------- Episodic memory --------------------------- */

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const content = sanitize(input.content);
    if (!content) throw new Error('Cannot store an empty memory');
    const hash = crypto.createHash('sha256').update(normalizeForHash(content)).digest('hex');
    const existing = this.db.get<MemoryRecord>('SELECT * FROM memories WHERE hash = ?', hash);
    const timestamp = nowIso();
    if (existing) {
      this.db.run(
        `UPDATE memories SET importance = MAX(importance, ?), pinned = MAX(pinned, ?), updated_at = ?,
         access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
        clamp01(input.importance ?? 0.5),
        input.pinned ? 1 : 0,
        timestamp,
        timestamp,
        existing.id,
      );
      return this.getMemory(existing.id) ?? existing;
    }

    const id = newId('mem');
    let embedding: Uint8Array | null = null;
    let embeddingModel: string | null = null;
    if (this.embedder?.available) {
      const vector = await this.embedder.embedOne(content);
      if (vector) {
        embedding = vectorToBlob(vector);
        embeddingModel = this.embedder.model;
      }
    }

    this.db.run(
      `INSERT INTO memories(id, content, kind, source, source_ref, importance, sensitivity, pinned, embedding, embedding_model, hash, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      content,
      input.kind ?? 'note',
      input.source ?? 'conversation',
      input.sourceRef ?? null,
      clamp01(input.importance ?? 0.5),
      input.sensitivity ?? 'private',
      input.pinned ? 1 : 0,
      embedding,
      embeddingModel,
      hash,
      timestamp,
      timestamp,
      input.expiresAt ?? null,
    );

    this.insertCounter += 1;
    if (this.insertCounter % 25 === 0) this.enforceLimits();
    return this.getMemory(id)!;
  }

  async rememberMany(inputs: RememberInput[]): Promise<MemoryRecord[]> {
    const results: MemoryRecord[] = [];
    for (const input of inputs) {
      try {
        results.push(await this.remember(input));
      } catch (error) {
        this.logger.warn('failed to store memory', {error: (error as Error).message});
      }
    }
    return results;
  }

  getMemory(id: string): MemoryRecord | undefined {
    return this.db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', id);
  }

  async search(query: string, options: SearchOptions = {}): Promise<MemoryHit[]> {
    const limit = options.limit ?? this.config.memory.recallLimit;
    const trimmed = query.trim();
    if (!trimmed) return this.recent(limit);
    const now = nowIso();
    const candidates = new Map<string, {memory: MemoryRecord; text: number; vector: number; via: Set<string>}>();

    const ftsQuery = buildFtsQuery(trimmed);
    if (ftsQuery) {
      try {
        const rows = this.db.all<MemoryRecord & {rank: number}>(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND (? = 1 OR m.expires_at IS NULL OR m.expires_at > ?)
           ORDER BY bm25(memories_fts) LIMIT 80`,
          ftsQuery,
          options.includeExpired ? 1 : 0,
          now,
        );
        rows.forEach((row, index) => {
          candidates.set(row.id, {
            memory: row,
            text: 1 - index / Math.max(rows.length, 12),
            vector: 0,
            via: new Set(['keyword']),
          });
        });
      } catch (error) {
        this.logger.debug('fts recall failed', {error: (error as Error).message});
      }
    }

    if (this.embedder?.available) {
      const queryVector = await this.embedder.embedOne(trimmed);
      if (queryVector) {
        const rows = this.db.all<MemoryRecord>(
          `SELECT * FROM memories WHERE embedding IS NOT NULL AND embedding_model = ?
           AND (? = 1 OR expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 2500`,
          this.embedder.model,
          options.includeExpired ? 1 : 0,
          now,
        );
        for (const row of rows) {
          const vector = blobToVector(row.embedding);
          if (!vector) continue;
          const similarity = Math.max(0, cosine(queryVector, vector));
          if (similarity < 0.2) continue;
          const entry = candidates.get(row.id) ?? {memory: row, text: 0, vector: 0, via: new Set<string>()};
          entry.vector = similarity;
          entry.via.add('semantic');
          candidates.set(row.id, entry);
        }
      }
    }

    if (candidates.size === 0) {
      const like = `%${trimmed.slice(0, 120).replace(/[%_]/g, '')}%`;
      const rows = this.db.all<MemoryRecord>(
        `SELECT * FROM memories WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?`,
        like,
        limit * 3,
      );
      rows.forEach((row, index) => {
        candidates.set(row.id, {memory: row, text: 1 - index / Math.max(rows.length, 12), vector: 0, via: new Set(['like'])});
      });
    }

    const hasSemantic = [...candidates.values()].some((entry) => entry.via.has('semantic'));
    const scored: MemoryHit[] = [];
    for (const entry of candidates.values()) {
      if (options.kinds?.length && !options.kinds.includes(entry.memory.kind)) continue;
      const ageDays = Math.max(0, (Date.now() - Date.parse(entry.memory.updated_at)) / 86_400_000);
      const recency = Math.exp(-ageDays / 120);
      const importance = clamp01(entry.memory.importance);
      const pinBoost = entry.memory.pinned ? 0.06 : 0;
      const score = hasSemantic
        ? 0.55 * entry.vector + 0.28 * entry.text + 0.1 * importance + 0.07 * recency + pinBoost
        : 0.68 * entry.text + 0.2 * importance + 0.12 * recency + pinBoost;
      if (score < (options.minScore ?? 0)) continue;
      scored.push({memory: entry.memory, score, via: [...entry.via]});
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    this.touch(top.map((hit) => hit.memory.id));
    return top;
  }

  recent(limit = 10): MemoryHit[] {
    const rows = this.db.all<MemoryRecord>(
      `SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ? ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
      nowIso(),
      limit,
    );
    return rows.map((memory, index) => ({memory, score: 1 - index / Math.max(rows.length, 10), via: ['recent']}));
  }

  list(options: {limit?: number; offset?: number; kind?: string} = {}): MemoryRecord[] {
    const limit = Math.min(options.limit ?? 50, 500);
    const offset = options.offset ?? 0;
    if (options.kind) {
      return this.db.all<MemoryRecord>('SELECT * FROM memories WHERE kind = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?', options.kind, limit, offset);
    }
    return this.db.all<MemoryRecord>('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ? OFFSET ?', limit, offset);
  }

  count(): number {
    return this.db.tableCount('memories');
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM memories WHERE id = ?', id).changes > 0;
  }

  setPinned(id: string, pinned: boolean): boolean {
    return this.db.run('UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?', pinned ? 1 : 0, nowIso(), id).changes > 0;
  }

  /** Remove expired memories and enforce the configured cap. */
  prune(): {expired: number; overflow: number} {
    const expired = this.db.run(`DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?`, nowIso()).changes;
    const max = this.config.memory.maxMemories;
    const count = this.count();
    let overflow = 0;
    if (count > max) {
      const excess = count - max;
      overflow = this.db.run(
        `DELETE FROM memories WHERE id IN (
           SELECT id FROM memories WHERE pinned = 0 ORDER BY importance ASC, updated_at ASC LIMIT ?
         )`,
        excess,
      ).changes;
    }
    return {expired, overflow};
  }

  /** Compact, human-readable block of relevant memories for the prompt. */
  async contextBlock(query: string, maxChars = this.config.memory.maxRecallChars): Promise<{text: string; hits: MemoryHit[]}> {
    let hits: MemoryHit[] = [];
    try {
      hits = await this.search(query, {limit: this.config.memory.recallLimit, minScore: 0.08});
    } catch (error) {
      this.logger.warn('memory recall failed', {error: (error as Error).message});
    }
    if (!hits.length) return {text: '', hits: []};
    const lines: string[] = [];
    let used = 0;
    for (const hit of hits) {
      const when = hit.memory.created_at.slice(0, 10);
      const line = `- [${hit.memory.id}] (${when}, ${hit.memory.source}${hit.memory.kind !== 'note' ? `, ${hit.memory.kind}` : ''}) ${hit.memory.content.replace(/\s+/g, ' ').trim()}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return {text: lines.join('\n'), hits: hits.slice(0, lines.length)};
  }

  /* ------------------------------ User profile ---------------------------- */

  async setFact(input: SetFactInput): Promise<{fact: ProfileFact; superseded?: ProfileFact}> {
    const key = normalizeKey(input.key);
    if (!key) throw new Error('Profile fact key is required');
    const value = input.value.trim();
    if (!value) throw new Error('Profile fact value is required');
    const timestamp = nowIso();
    const active = this.db.get<ProfileFact>('SELECT * FROM profile_facts WHERE key = ? AND superseded_by IS NULL', key);

    if (active && normalizeForHash(active.value) === normalizeForHash(value)) {
      this.db.run(
        'UPDATE profile_facts SET confidence = MAX(confidence, ?), last_confirmed_at = ?, updated_at = ? WHERE id = ?',
        clamp01(input.confidence ?? 0.8),
        timestamp,
        timestamp,
        active.id,
      );
      return {fact: this.db.get<ProfileFact>('SELECT * FROM profile_facts WHERE id = ?', active.id)!};
    }

    const id = newId('fact');
    let embedding: Uint8Array | null = null;
    if (this.embedder?.available) {
      const vector = await this.embedder.embedOne(`${key}: ${value}`);
      if (vector) embedding = vectorToBlob(vector);
    }

    this.db.transaction(() => {
      if (active) this.db.run('UPDATE profile_facts SET superseded_by = ?, updated_at = ? WHERE id = ?', id, timestamp, id === active.id ? '' : active.id);
      this.db.run(
        `INSERT INTO profile_facts(id, key, value, category, confidence, source, sensitivity, embedding, created_at, updated_at, last_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        key,
        value,
        input.category ?? 'general',
        clamp01(input.confidence ?? 0.8),
        input.source ?? 'conversation',
        input.sensitivity ?? 'private',
        embedding,
        timestamp,
        timestamp,
        timestamp,
      );
    });

    const fact = this.db.get<ProfileFact>('SELECT * FROM profile_facts WHERE id = ?', id)!;
    return {fact, superseded: active ?? undefined};
  }

  getProfile(options: {limit?: number; category?: string; activeOnly?: boolean} = {}): ProfileFact[] {
    const limit = Math.min(options.limit ?? 100, 1000);
    if (options.category) {
      return this.db.all<ProfileFact>(
        'SELECT * FROM profile_facts WHERE superseded_by IS NULL AND category = ? ORDER BY confidence DESC, updated_at DESC LIMIT ?',
        options.category,
        limit,
      );
    }
    return this.db.all<ProfileFact>(
      'SELECT * FROM profile_facts WHERE superseded_by IS NULL ORDER BY category, confidence DESC, updated_at DESC LIMIT ?',
      limit,
    );
  }

  getFact(id: string): ProfileFact | undefined {
    return this.db.get<ProfileFact>('SELECT * FROM profile_facts WHERE id = ?', id);
  }

  historyFor(key: string): ProfileFact[] {
    return this.db.all<ProfileFact>('SELECT * FROM profile_facts WHERE key = ? ORDER BY created_at DESC', normalizeKey(key));
  }

  deleteFact(id: string): boolean {
    return this.db.run('DELETE FROM profile_facts WHERE id = ?', id).changes > 0;
  }

  async profileBlock(maxChars = 4000): Promise<string> {
    const facts = this.getProfile({limit: 200});
    if (!facts.length) return '';
    const grouped = new Map<string, ProfileFact[]>();
    for (const fact of facts) {
      const list = grouped.get(fact.category) ?? [];
      list.push(fact);
      grouped.set(fact.category, list);
    }
    const categoryOrder = ['identity', 'location', 'work', 'health', 'relationships', 'preferences', 'goals', 'projects', 'finance', 'general'];
    const lines: string[] = [];
    let used = 0;
    for (const category of [...grouped.keys()].sort((a, b) => {
      const ai = categoryOrder.indexOf(a);
      const bi = categoryOrder.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })) {
      for (const fact of grouped.get(category)!) {
        const line = `- ${category}/${fact.key}: ${fact.value} (confidence ${fact.confidence.toFixed(2)}, source ${fact.source ?? 'unknown'})`;
        if (used + line.length > maxChars) return lines.join('\n');
        lines.push(line);
        used += line.length;
      }
    }
    return lines.join('\n');
  }

  /* ------------------------------ Entity graph ---------------------------- */

  upsertEntity(input: {name: string; type?: string; aliases?: string[]; notes?: string}): EntityRecord {
    const name = input.name.trim();
    const type = input.type ?? 'person';
    if (!name) throw new Error('Entity name is required');
    const existing = this.db.get<EntityRecord>('SELECT * FROM entities WHERE lower(name) = lower(?) AND type = ?', name, type);
    const timestamp = nowIso();
    if (existing) {
      const aliases = new Set([...(parseAliases(existing.aliases)), ...(input.aliases ?? [])]);
      this.db.run(
        'UPDATE entities SET aliases = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?',
        aliases.size ? JSON.stringify([...aliases]) : null,
        input.notes ?? null,
        timestamp,
        existing.id,
      );
      return this.db.get<EntityRecord>('SELECT * FROM entities WHERE id = ?', existing.id)!;
    }
    const id = newId('ent');
    this.db.run(
      'INSERT INTO entities(id, name, type, aliases, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      name,
      type,
      input.aliases?.length ? JSON.stringify(input.aliases) : null,
      input.notes ?? null,
      timestamp,
      timestamp,
    );
    return this.db.get<EntityRecord>('SELECT * FROM entities WHERE id = ?', id)!;
  }

  link(fromName: string, predicate: string, to: {name?: string; value?: string}, options: {confidence?: number; source?: string} = {}): void {
    const from = this.upsertEntity({name: fromName});
    let toId: string | null = null;
    if (to.name) toId = this.upsertEntity({name: to.name}).id;
    this.db.run(
      `INSERT INTO relations(id, from_id, predicate, to_id, to_value, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('rel'),
      from.id,
      predicate,
      toId,
      to.value ?? null,
      clamp01(options.confidence ?? 0.7),
      options.source ?? 'conversation',
      nowIso(),
    );
  }

  searchEntities(query: string, limit = 10): Array<EntityRecord & {relations: Array<{predicate: string; to: string | null}>}> {
    const like = `%${query.trim()}%`;
    const entities = this.db.all<EntityRecord>(
      'SELECT * FROM entities WHERE lower(name) LIKE lower(?) OR lower(COALESCE(aliases, \'\')) LIKE lower(?) ORDER BY updated_at DESC LIMIT ?',
      like,
      like,
      limit,
    );
    return entities.map((entity) => {
      const relations = this.db.all<{predicate: string; to: string | null}>(
        `SELECT r.predicate, COALESCE(e.name, r.to_value) AS "to" FROM relations r
         LEFT JOIN entities e ON e.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC LIMIT 20`,
        entity.id,
      );
      return {...entity, relations};
    });
  }

  /* -------------------------------- Helpers ------------------------------- */

  private touch(ids: string[]): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    try {
      this.db.run(
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (${placeholders})`,
        nowIso(),
        ...ids,
      );
    } catch {
      // access bookkeeping is best-effort
    }
  }

  private enforceLimits(): void {
    try {
      const {expired, overflow} = this.prune();
      if (expired || overflow) this.logger.info('memory pruned', {expired, overflow});
    } catch (error) {
      this.logger.warn('memory prune failed', {error: (error as Error).message});
    }
  }
}

export function sanitize(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, MAX_CONTENT_CHARS);
}

export function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export function normalizeForHash(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

export function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '')}"*`).join(' OR ');
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
