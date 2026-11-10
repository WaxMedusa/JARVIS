import fs from 'node:fs/promises';
import path from 'node:path';
import type {JarvisConfig} from '../config.js';
import {newId} from '../core/ids.js';
import {nowIso} from '../core/time.js';
import type {JarvisDB} from '../db/database.js';
import {buildFtsQuery} from './memory.js';

export const NOTE_CONTENT_MAX = 100_000;
export const NOTE_TITLE_MAX = 200;
export const NOTE_SUMMARY_MAX = 4_000;

export interface NoteRecord {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  source: string;
  audio_path: string | null;
  audio_mime: string | null;
  duration_seconds: number | null;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

interface NoteRow extends Omit<NoteRecord, 'tags' | 'pinned' | 'archived'> {
  tags: string;
  pinned: number;
  archived: number;
}

export interface CreateNoteInput {
  title?: string;
  content: string;
  summary?: string | null;
  tags?: string[] | string;
  source?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  summary?: string | null;
  tags?: string[] | string;
  pinned?: boolean;
  archived?: boolean;
}

export interface ListNotesOptions {
  query?: string;
  tag?: string;
  archived?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Notes are user-authored, durable capture — distinct from episodic memories.
 * Every note is full-text indexed and may own one local audio attachment.
 */
export class NoteService {
  private readonly db: JarvisDB;
  private readonly config: JarvisConfig;

  constructor(options: {db: JarvisDB; config: JarvisConfig}) {
    this.db = options.db;
    this.config = options.config;
  }

  create(input: CreateNoteInput): NoteRecord {
    const content = sanitizeContent(input.content);
    const title = cleanTitle(input.title) || deriveTitle(content);
    if (!content && !title) throw new Error('A note needs a title or content.');
    const id = newId('note');
    const timestamp = nowIso();
    this.db.run(
      `INSERT INTO notes(id, title, content, summary, tags, source, pinned, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title || 'Untitled note',
      content,
      cleanSummary(input.summary),
      JSON.stringify(normalizeTags(input.tags)),
      cleanSource(input.source),
      input.pinned ? 1 : 0,
      input.archived ? 1 : 0,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  }

  get(id: string): NoteRecord | undefined {
    const row = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id);
    return row ? mapRow(row) : undefined;
  }

  resolve(idOrPrefix: string): NoteRecord | undefined {
    const value = idOrPrefix.trim();
    if (!value) return undefined;
    const exact = this.get(value);
    if (exact) return exact;
    const rows = this.db.all<NoteRow>("SELECT * FROM notes WHERE id LIKE ? ESCAPE '!' LIMIT 2", `${escapeLike(value)}%`);
    return rows.length === 1 ? mapRow(rows[0]!) : undefined;
  }

  list(options: ListNotesOptions = {}): NoteRecord[] {
    const requestedLimit = Number(options.limit ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 50;
    const requestedOffset = Number(options.offset ?? 0);
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    const archived = options.archived ? 1 : 0;
    const tag = cleanTag(options.tag ?? '');
    const query = (options.query ?? '').trim();

    if (query) {
      const fts = buildFtsQuery(query);
      if (fts) {
        try {
          return this.db
            .all<NoteRow>(
              `SELECT n.* FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
               WHERE notes_fts MATCH ? AND n.archived = ?${tag ? " AND n.tags LIKE ? ESCAPE '!'" : ''}
               ORDER BY bm25(notes_fts), n.pinned DESC LIMIT ? OFFSET ?`,
              ...(tag ? [fts, archived, `%"${escapeLike(tag)}"%`, limit, offset] : [fts, archived, limit, offset]),
            )
            .map(mapRow);
        } catch {
          // Fall through to a resilient LIKE search if FTS is unavailable or malformed.
        }
      }
      const like = `%${escapeLike(query.slice(0, 160))}%`;
      return this.db
        .all<NoteRow>(
          `SELECT * FROM notes WHERE archived = ?${tag ? " AND tags LIKE ? ESCAPE '!'" : ''}
           AND (title LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR COALESCE(summary, '') LIKE ? ESCAPE '!')
           ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
          ...(tag ? [archived, `%"${escapeLike(tag)}"%`, like, like, like, limit, offset] : [archived, like, like, like, limit, offset]),
        )
        .map(mapRow);
    }

    if (tag) {
      return this.db
        .all<NoteRow>(
          `SELECT * FROM notes WHERE archived = ? AND tags LIKE ? ESCAPE '!'
           ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
          archived,
          `%"${escapeLike(tag)}"%`,
          limit,
          offset,
        )
        .map(mapRow);
    }

    return this.db
      .all<NoteRow>(
        `SELECT * FROM notes WHERE archived = ?
         ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
        archived,
        limit,
        offset,
      )
      .map(mapRow);
  }

  update(id: string, patch: UpdateNoteInput): NoteRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.title !== undefined) {
      fields.push('title = ?');
      values.push(cleanTitle(patch.title) || deriveTitle(existing.content) || 'Untitled note');
    }
    if (patch.content !== undefined) {
      const content = sanitizeContent(patch.content);
      const title = patch.title !== undefined ? cleanTitle(patch.title) : existing.title;
      if (!content && !title) throw new Error('A note needs a title or content.');
      fields.push('content = ?');
      values.push(content);
    }
    if (patch.summary !== undefined) {
      fields.push('summary = ?');
      values.push(cleanSummary(patch.summary));
    }
    if (patch.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(normalizeTags(patch.tags)));
    }
    if (patch.pinned !== undefined) {
      fields.push('pinned = ?');
      values.push(patch.pinned ? 1 : 0);
    }
    if (patch.archived !== undefined) {
      fields.push('archived = ?');
      values.push(patch.archived ? 1 : 0);
    }
    if (!fields.length) return existing;

    fields.push('updated_at = ?');
    values.push(nowIso());
    values.push(id);
    this.db.run(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`, ...values);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const note = this.get(id);
    if (!note) return false;
    this.db.run('DELETE FROM notes WHERE id = ?', id);
    if (note.audio_path) {
      try {
        await fs.rm(this.audioFilePath(note), {force: true});
      } catch {
        // The database is the source of truth; orphan cleanup is best effort.
      }
    }
    return true;
  }

  count(options: {archived?: boolean} = {}): number {
    const row = this.db.get<{n: number}>('SELECT COUNT(*) AS n FROM notes WHERE archived = ?', options.archived ? 1 : 0);
    return Number(row?.n ?? 0);
  }

  stats(): {active: number; archived: number; withAudio: number} {
    const row = this.db.get<{active: number; archived: number; withAudio: number}>(
      `SELECT
         SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN audio_path IS NOT NULL THEN 1 ELSE 0 END) AS withAudio
       FROM notes`,
    );
    return {
      active: Number(row?.active ?? 0),
      archived: Number(row?.archived ?? 0),
      withAudio: Number(row?.withAudio ?? 0),
    };
  }

  tags(): string[] {
    const counts = new Map<string, number>();
    for (const row of this.db.all<{tags: string}>('SELECT tags FROM notes WHERE archived = 0')) {
      for (const tag of parseTags(row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
  }

  /** Persist the original recording beside the database and attach it to the note. */
  async saveAudio(noteId: string, buffer: Buffer, mime: string): Promise<NoteRecord> {
    const note = this.get(noteId);
    if (!note) throw new Error('Note not found.');
    if (!buffer.length) throw new Error('Audio recording is empty.');
    if (buffer.length > this.config.voice.maxAudioBytes) throw new Error('Audio recording is too large.');
    const extension = audioExtension(mime);
    const filename = `${note.id}.${extension}`;
    const directory = this.audioDirectory();
    await fs.mkdir(directory, {recursive: true});
    const target = path.join(directory, filename);
    await fs.writeFile(target, buffer, {mode: 0o600});
    this.db.run(
      'UPDATE notes SET audio_path = ?, audio_mime = ?, updated_at = ? WHERE id = ?',
      filename,
      normalizeAudioMime(mime),
      nowIso(),
      note.id,
    );
    return this.get(note.id)!;
  }

  setAudioDuration(noteId: string, seconds: number | null): NoteRecord | undefined {
    const duration = seconds === null || !Number.isFinite(seconds) ? null : Math.max(0, Math.min(seconds, 21_600));
    this.db.run('UPDATE notes SET duration_seconds = ?, updated_at = ? WHERE id = ?', duration, nowIso(), noteId);
    return this.get(noteId);
  }

  async readAudio(note: NoteRecord): Promise<{data: Buffer; mime: string}> {
    if (!note.audio_path) throw new Error('This note has no audio attachment.');
    const data = await fs.readFile(this.audioFilePath(note));
    return {data, mime: note.audio_mime || normalizeAudioMime('audio/webm')};
  }

  private audioDirectory(): string {
    return path.join(this.config.paths.home, 'notes-audio');
  }

  private audioFilePath(note: NoteRecord): string {
    if (!note.audio_path) throw new Error('This note has no audio attachment.');
    const filename = path.basename(note.audio_path);
    if (filename !== note.audio_path) throw new Error('Invalid audio attachment path.');
    return path.join(this.audioDirectory(), filename);
  }
}

export function normalizeTags(raw: unknown): string[] {
  let values: unknown[] = [];
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) values = parsed;
      } catch {
        values = trimmed.split(',');
      }
    } else {
      values = trimmed.split(',');
    }
  }
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tag = cleanTag(value);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 16) break;
  }
  return tags;
}

export function normalizeAudioMime(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.split(';')[0]!.trim().toLowerCase() : '';
  if (!value) return 'audio/webm';
  if (value === 'video/webm') return 'audio/webm';
  if (value === 'audio/x-wav') return 'audio/wav';
  if (value === 'audio/x-m4a') return 'audio/mp4';
  if (value === 'audio/mp3') return 'audio/mpeg';
  return value;
}

export function isSupportedAudioMime(raw: unknown): boolean {
  const mime = normalizeAudioMime(raw);
  return (
    mime.startsWith('audio/') ||
    mime === 'application/octet-stream'
  );
}

export function audioExtension(raw: unknown): string {
  const mime = normalizeAudioMime(raw);
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'ogg';
  if (mime === 'audio/wav') return 'wav';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'audio/mp4' || mime === 'audio/aac') return 'm4a';
  if (mime === 'audio/flac') return 'flac';
  return 'webm';
}

function mapRow(row: NoteRow): NoteRecord {
  return {
    ...row,
    tags: parseTags(row.tags),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
  };
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return normalizeTags(raw);
  if (typeof raw !== 'string') return [];
  try {
    return normalizeTags(JSON.parse(raw) as unknown);
  } catch {
    return normalizeTags(raw);
  }
}

function sanitizeContent(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, NOTE_CONTENT_MAX);
}

function cleanTitle(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_TITLE_MAX);
}

function cleanSummary(raw: unknown): string | null {
  const value = String(raw ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, NOTE_SUMMARY_MAX);
  return value || null;
}

function cleanSource(raw: unknown): string {
  const value = String(raw ?? 'manual')
    .trim()
    .toLowerCase()
    .slice(0, 40);
  return /^[a-z0-9_-]+$/.test(value) ? value : 'manual';
}

function cleanTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
}

function deriveTitle(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine;
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, '!$&');
}
