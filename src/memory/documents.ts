import crypto from 'node:crypto';
import fsSync, {type Dirent} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {JarvisConfig} from '../config.js';
import {newId} from '../core/ids.js';
import {getLogger, type Logger} from '../core/logger.js';
import {nowIso} from '../core/time.js';
import type {JarvisDB} from '../db/database.js';
import type {Policy} from '../security/policy.js';
import {blobToVector, cosine, vectorToBlob, type Embedder} from '../llm/embeddings.js';
import {buildFtsQuery} from './memory.js';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.org',
  '.rst',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.yml',
  '.yaml',
  '.log',
  '.html',
  '.htm',
  '.xml',
  '.tex',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', 'vendor', 'target']);

export interface IndexStats {
  scanned: number;
  indexed: number;
  skipped: number;
  chunks: number;
  errors: string[];
}

export interface DocumentSearchHit {
  path: string;
  title: string;
  content: string;
  score: number;
  ordinal: number;
}

interface DocumentRow {
  id: string;
  path: string;
  title: string | null;
  kind: string | null;
  hash: string | null;
  size: number | null;
  mtime: string | null;
  indexed_at: string;
  meta: string | null;
}

interface ChunkRow {
  id: string;
  document_id: string;
  ord: number;
  content: string;
  embedding: Uint8Array | null;
  embedding_model: string | null;
}

/**
 * Local document index (Obsidian vault, notes, exports) with chunking and
 * hybrid retrieval. This is what lets JARVIS answer from your own writing.
 */
export class DocumentIndex {
  private readonly db: JarvisDB;
  private readonly config: JarvisConfig;
  private readonly policy: Policy;
  private readonly embedder: Embedder | null;
  private readonly logger: Logger;

  constructor(options: {db: JarvisDB; config: JarvisConfig; policy: Policy; embedder?: Embedder | null}) {
    this.db = options.db;
    this.config = options.config;
    this.policy = options.policy;
    this.embedder = options.embedder ?? null;
    this.logger = getLogger().child('documents');
  }

  async indexPath(target: string, options: {recursive?: boolean; force?: boolean} = {}): Promise<IndexStats> {
    const stats: IndexStats = {scanned: 0, indexed: 0, skipped: 0, chunks: 0, errors: []};
    let resolved: string;
    try {
      resolved = this.policy.assertPath(target, {mustExist: true});
    } catch (error) {
      stats.errors.push((error as Error).message);
      return stats;
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) {
      stats.errors.push(`Not found: ${target}`);
      return stats;
    }

    if (stat.isFile()) {
      stats.scanned = 1;
      const result = await this.indexFile(resolved, options.force);
      if (result.indexed) {
        stats.indexed += 1;
        stats.chunks += result.chunks;
      } else {
        stats.skipped += 1;
        if (result.error) stats.errors.push(result.error);
      }
      return stats;
    }

    const stack = [resolved];
    const maxFiles = 5000;
    while (stack.length && stats.scanned < maxFiles) {
      const current = stack.pop()!;
      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(current, {withFileTypes: true});
      } catch (error) {
        stats.errors.push(`${current}: ${(error as Error).message}`);
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (options.recursive === false) continue;
          if (SKIP_DIRS.has(entry.name)) continue;
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        stats.scanned += 1;
        const result = await this.indexFile(full, options.force);
        if (result.indexed) {
          stats.indexed += 1;
          stats.chunks += result.chunks;
        } else {
          stats.skipped += 1;
          if (result.error) stats.errors.push(result.error);
        }
      }
    }
    this.logger.info('indexed documents', {target: resolved, ...stats, errors: stats.errors.length});
    return stats;
  }

  async indexFile(filePath: string, force = false): Promise<{indexed: boolean; chunks: number; error?: string}> {
    try {
      const resolved = this.policy.assertPath(filePath, {mustExist: true});
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) return {indexed: false, chunks: 0, error: 'not a file'};
      if (stat.size > 4 * 1024 * 1024) return {indexed: false, chunks: 0, error: 'file too large (>4MB)'};
      const raw = await fs.readFile(resolved, 'utf8');
      const content = normalizeDocument(raw, path.extname(resolved));
      if (!content.trim()) return {indexed: false, chunks: 0};
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const existing = this.db.get<DocumentRow>('SELECT * FROM documents WHERE path = ?', resolved);
      if (existing && existing.hash === hash && !force) return {indexed: false, chunks: 0};

      const docId = existing?.id ?? newId('doc');
      const title = extractTitle(content, resolved);
      const timestamp = nowIso();
      const chunks = chunkText(content, this.config.memory.documentChunkChars, this.config.memory.documentChunkOverlap);

      this.db.transaction(() => {
        if (existing) {
          this.db.run('DELETE FROM chunks WHERE document_id = ?', docId);
          this.db.run(
            'UPDATE documents SET title = ?, kind = ?, hash = ?, size = ?, mtime = ?, indexed_at = ?, meta = ? WHERE id = ?',
            title,
            path.extname(resolved).slice(1),
            hash,
            stat.size,
            stat.mtime.toISOString(),
            timestamp,
            JSON.stringify({relative: path.relative(process.cwd(), resolved)}),
            docId,
          );
        } else {
          this.db.run(
            `INSERT INTO documents(id, path, title, kind, hash, size, mtime, indexed_at, meta)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            docId,
            resolved,
            title,
            path.extname(resolved).slice(1),
            hash,
            stat.size,
            stat.mtime.toISOString(),
            timestamp,
            JSON.stringify({relative: path.relative(process.cwd(), resolved)}),
          );
        }
        for (let i = 0; i < chunks.length; i += 1) {
          this.db.run('INSERT INTO chunks(id, document_id, ord, content) VALUES (?, ?, ?, ?)', newId('chk'), docId, i, chunks[i]!);
        }
      });

      if (this.embedder?.available) await this.embedPending(docId);
      return {indexed: true, chunks: chunks.length};
    } catch (error) {
      return {indexed: false, chunks: 0, error: (error as Error).message};
    }
  }

  private async embedPending(documentId: string): Promise<void> {
    if (!this.embedder?.available) return;
    const chunks = this.db.all<ChunkRow>('SELECT * FROM chunks WHERE document_id = ? AND embedding IS NULL ORDER BY ord', documentId);
    if (!chunks.length) return;
    const vectors = await this.embedder.embed(chunks.map((chunk) => chunk.content));
    this.db.transaction(() => {
      chunks.forEach((chunk, index) => {
        const vector = vectors[index];
        if (vector) {
          this.db.run('UPDATE chunks SET embedding = ?, embedding_model = ? WHERE id = ?', vectorToBlob(vector), this.embedder!.model, chunk.id);
        }
      });
    });
  }

  async search(query: string, limit = 8): Promise<DocumentSearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const results = new Map<string, DocumentSearchHit & {vector: number; text: number}>();
    const ftsQuery = buildFtsQuery(trimmed);
    if (ftsQuery) {
      try {
        const rows = this.db.all<ChunkRow & {path: string; title: string | null}>(
          `SELECT c.*, d.path, d.title FROM chunks_fts f
           JOIN chunks c ON c.rowid = f.rowid JOIN documents d ON d.id = c.document_id
           WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 60`,
          ftsQuery,
        );
        rows.forEach((row, index) => {
          results.set(row.id, {
            path: row.path,
            title: row.title ?? path.basename(row.path),
            content: row.content,
            ordinal: row.ord,
            score: 0,
            vector: 0,
            text: 1 - index / Math.max(rows.length, 12),
          });
        });
      } catch (error) {
        this.logger.debug('chunk fts failed', {error: (error as Error).message});
      }
    }

    if (this.embedder?.available) {
      const queryVector = await this.embedder.embedOne(trimmed);
      if (queryVector) {
        const rows = this.db.all<ChunkRow & {path: string; title: string | null}>(
          `SELECT c.*, d.path, d.title FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.embedding IS NOT NULL AND c.embedding_model = ? ORDER BY d.indexed_at DESC LIMIT 4000`,
          this.embedder.model,
        );
        for (const row of rows) {
          const vector = blobToVector(row.embedding);
          if (!vector) continue;
          const similarity = Math.max(0, cosine(queryVector, vector));
          if (similarity < 0.25) continue;
          const entry = results.get(row.id) ?? {
            path: row.path,
            title: row.title ?? path.basename(row.path),
            content: row.content,
            ordinal: row.ord,
            score: 0,
            vector: 0,
            text: 0,
          };
          entry.vector = similarity;
          results.set(row.id, entry);
        }
      }
    }

    return [...results.values()]
      .map((entry) => ({
        path: entry.path,
        title: entry.title,
        content: entry.content,
        ordinal: entry.ordinal,
        score: 0.6 * entry.vector + 0.4 * entry.text,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  stats(): {documents: number; chunks: number; embedded: number} {
    const documents = this.db.tableCount('documents');
    const chunks = this.db.tableCount('chunks');
    const embedded = Number(this.db.get<{n: number}>('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL')?.n ?? 0);
    return {documents, chunks, embedded};
  }

  removeMissing(root: string): number {
    let removed = 0;
    const docs = this.db.all<DocumentRow>('SELECT * FROM documents');
    for (const doc of docs) {
      if (!doc.path.startsWith(root)) continue;
      try {
        if (!fsSync.existsSync(doc.path)) {
          this.db.run('DELETE FROM documents WHERE id = ?', doc.id);
          removed += 1;
        }
      } catch {
        // ignore unreadable paths
      }
    }
    return removed;
  }
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, '\n');
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (boundary > size * 0.5) end = start + boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function normalizeDocument(raw: string, extension: string): string {
  if (extension === '.html' || extension === '.htm' || extension === '.xml') {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }
  return raw;
}

function extractTitle(content: string, filePath: string): string {
  const heading = /^#\s+(.+)$/m.exec(content.slice(0, 2000));
  if (heading?.[1]) return heading[1].trim().slice(0, 160);
  return path.basename(filePath, path.extname(filePath));
}
