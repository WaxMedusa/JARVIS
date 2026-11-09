import {newId} from '../core/ids.js';
import {nowIso} from '../core/time.js';
import type {JarvisDB} from '../db/database.js';
import {redact} from '../core/redact.js';
import type {LLMMessage, ToolCall} from '../llm/types.js';

export interface ConversationRecord {
  id: string;
  title: string | null;
  channel: string;
  summary: string | null;
  summary_upto_message_row: number;
  turn_count: number;
  created_at: string;
  updated_at: string;
  archived: number;
}

export interface MessageRecord {
  id: number;
  conversation_id: string;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
  tokens: number | null;
  metadata: string | null;
  created_at: string;
}

export interface AppendMessageInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  tokens?: number;
  metadata?: Record<string, unknown>;
}

/** Conversation transcript storage with summaries for context compaction. */
export class ConversationStore {
  private readonly db: JarvisDB;

  constructor(db: JarvisDB) {
    this.db = db;
  }

  create(channel = 'cli', title?: string): ConversationRecord {
    const id = newId('conv');
    const timestamp = nowIso();
    this.db.run(
      'INSERT INTO conversations(id, title, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      title ?? null,
      channel,
      timestamp,
      timestamp,
    );
    return this.get(id)!;
  }

  get(id: string): ConversationRecord | undefined {
    return this.db.get<ConversationRecord>('SELECT * FROM conversations WHERE id = ?', id);
  }

  getOrCreate(id: string | undefined, channel = 'cli'): ConversationRecord {
    if (id) {
      const existing = this.get(id);
      if (existing) return existing;
    }
    return this.create(channel);
  }

  latest(channel?: string): ConversationRecord | undefined {
    if (channel) {
      return this.db.get<ConversationRecord>(
        'SELECT * FROM conversations WHERE archived = 0 AND channel = ? ORDER BY updated_at DESC LIMIT 1',
        channel,
      );
    }
    return this.db.get<ConversationRecord>('SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1');
  }

  list(limit = 20): ConversationRecord[] {
    return this.db.all<ConversationRecord>('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?', Math.min(limit, 200));
  }

  append(conversationId: string, message: AppendMessageInput): MessageRecord {
    const conversation = this.get(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} not found`);
    const timestamp = nowIso();
    const content = message.role === 'user' ? message.content : redact(message.content);
    const result = this.db.run(
      `INSERT INTO messages(conversation_id, role, content, tool_calls, tool_call_id, name, tokens, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      message.role,
      content,
      message.toolCalls?.length ? JSON.stringify(message.toolCalls) : null,
      message.toolCallId ?? null,
      message.name ?? null,
      message.tokens ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      timestamp,
    );
    const patch: {title?: string} = {};
    if (!conversation.title && message.role === 'user') {
      patch.title = message.content.replace(/\s+/g, ' ').trim().slice(0, 72) || 'New conversation';
    }
    this.db.run(
      `UPDATE conversations SET updated_at = ?, title = COALESCE(?, title) WHERE id = ?`,
      timestamp,
      patch.title ?? null,
      conversationId,
    );
    return this.db.get<MessageRecord>('SELECT * FROM messages WHERE id = ?', result.lastInsertRowid)!;
  }

  messages(conversationId: string, options: {limit?: number; afterRow?: number} = {}): MessageRecord[] {
    const limit = Math.min(options.limit ?? 200, 1000);
    if (options.afterRow !== undefined) {
      return this.db.all<MessageRecord>(
        'SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
        conversationId,
        options.afterRow,
        limit,
      );
    }
    const rows = this.db.all<MessageRecord>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
      conversationId,
      limit,
    );
    return rows.reverse();
  }

  recent(conversationId: string, limit = 40, sinceRow = 0): MessageRecord[] {
    const rows = this.db.all<MessageRecord>(
      'SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
      conversationId,
      sinceRow,
      Math.min(limit, 500),
    );
    return rows.reverse();
  }

  setSummary(conversationId: string, summary: string, uptoRow: number): void {
    this.db.run(
      'UPDATE conversations SET summary = ?, summary_upto_message_row = ?, updated_at = ? WHERE id = ?',
      summary,
      uptoRow,
      nowIso(),
      conversationId,
    );
  }

  incrementTurns(conversationId: string): number {
    this.db.run('UPDATE conversations SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?', nowIso(), conversationId);
    return this.get(conversationId)?.turn_count ?? 0;
  }

  archive(conversationId: string): void {
    this.db.run('UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?', nowIso(), conversationId);
  }

  delete(conversationId: string): void {
    this.db.run('DELETE FROM conversations WHERE id = ?', conversationId);
  }

  countMessages(conversationId: string): number {
    const row = this.db.get<{n: number}>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId);
    return Number(row?.n ?? 0);
  }

  /** Map stored rows into provider-neutral LLM messages. */
  toLLMMessages(rows: MessageRecord[], includeTools = true): LLMMessage[] {
    const output: LLMMessage[] = [];
    for (const row of rows) {
      if (row.role === 'user') output.push({role: 'user', content: row.content ?? ''});
      else if (row.role === 'assistant') {
        let toolCalls: ToolCall[] | undefined;
        if (row.tool_calls) {
          try {
            const parsed = JSON.parse(row.tool_calls);
            if (Array.isArray(parsed)) toolCalls = parsed as ToolCall[];
          } catch {
            toolCalls = undefined;
          }
        }
        output.push({role: 'assistant', content: row.content ?? '', ...(toolCalls?.length ? {toolCalls} : {})});
      } else if (row.role === 'tool' && includeTools) {
        output.push({
          role: 'tool',
          content: row.content ?? '',
          toolCallId: row.tool_call_id ?? undefined,
          name: row.name ?? undefined,
        });
      } else if (row.role === 'system') {
        output.push({role: 'system', content: row.content ?? ''});
      }
    }
    return output;
  }
}
