import type {JarvisConfig} from '../config.js';
import {getLogger, type Logger} from '../core/logger.js';
import {nowIso, parseDate} from '../core/time.js';
import type {JarvisDB} from '../db/database.js';
import type {LLMSet} from '../llm/index.js';
import type {ConversationStore} from './conversations.js';
import {EXTRACTION_INSTRUCTIONS, SUMMARY_INSTRUCTIONS, extractMemories} from './extract.js';
import type {MemoryService} from './memory.js';
import type {TaskService} from './tasks.js';

/**
 * After each exchange, distil durable facts into long-term memory and compact
 * older transcript into summaries. Runs in the background; failures never
 * break the reply.
 */
export class Consolidator {
  private readonly config: JarvisConfig;
  private readonly db: JarvisDB;
  private readonly memory: MemoryService;
  private readonly conversations: ConversationStore;
  private readonly tasks: TaskService;
  private readonly llm: LLMSet;
  private readonly logger: Logger;
  private running = new Set<string>();

  constructor(options: {
    config: JarvisConfig;
    db: JarvisDB;
    memory: MemoryService;
    conversations: ConversationStore;
    tasks: TaskService;
    llm: LLMSet;
  }) {
    this.config = options.config;
    this.db = options.db;
    this.memory = options.memory;
    this.conversations = options.conversations;
    this.tasks = options.tasks;
    this.llm = options.llm;
    this.logger = getLogger().child('consolidator');
  }

  /** Called after every assistant reply. Cheap unless a consolidation is due. */
  async afterTurn(conversationId: string): Promise<{memories: number; facts: number; tasks: number} | null> {
    if (!this.config.memory.extractFacts) return null;
    const turns = this.conversations.incrementTurns(conversationId);
    const every = this.config.memory.consolidateEveryTurns;
    if (turns % every !== 0) return null;
    return this.consolidate(conversationId);
  }

  async consolidate(conversationId: string): Promise<{memories: number; facts: number; tasks: number} | null> {
    if (this.running.has(conversationId)) return null;
    this.running.add(conversationId);
    try {
      const key = `extract:${conversationId}`;
      const lastRow = Number(this.db.kvGet(key) ?? 0);
      const rows = this.conversations.messages(conversationId, {afterRow: lastRow, limit: 60});
      const relevant = rows.filter((row) => row.role === 'user' || (row.role === 'assistant' && row.content));
      if (relevant.length < 2) return null;

      const transcript = relevant
        .map((row) => `${row.role === 'user' ? 'USER' : 'ASSISTANT'}: ${(row.content ?? '').slice(0, 3000)}`)
        .join('\n\n');
      const extraction = await extractMemories(this.llm.small, transcript);
      const maxRow = rows[rows.length - 1]?.id ?? lastRow;

      if (!extraction) {
        this.db.kvSet(key, String(maxRow));
        return null;
      }

      let memories = 0;
      let facts = 0;
      let tasks = 0;

      for (const item of extraction.memories) {
        try {
          await this.memory.remember({
            content: item.content,
            kind: item.kind,
            source: 'conversation',
            sourceRef: conversationId,
            importance: item.importance,
            sensitivity: item.sensitivity,
          });
          memories += 1;
        } catch (error) {
          this.logger.debug('memory extraction item failed', {error: (error as Error).message});
        }
      }

      for (const fact of extraction.facts) {
        try {
          const result = await this.memory.setFact({
            key: fact.key,
            value: fact.value,
            category: fact.category,
            confidence: fact.confidence,
            source: 'conversation',
            sensitivity: fact.sensitivity,
          });
          facts += 1;
          if (result.superseded) {
            this.logger.info('profile fact updated', {key: fact.key, from: result.superseded.value, to: fact.value});
          }
        } catch (error) {
          this.logger.debug('fact extraction item failed', {error: (error as Error).message});
        }
      }

      for (const entity of extraction.entities) {
        try {
          this.memory.upsertEntity({name: entity.name, type: entity.type === 'other' ? 'other' : entity.type, aliases: entity.aliases});
        } catch {
          // ignore individual entity failures
        }
      }
      for (const relation of extraction.relations) {
        try {
          this.memory.link(relation.from, relation.predicate, {name: relation.to, value: relation.to}, {source: conversationId});
        } catch {
          // ignore individual relation failures
        }
      }

      for (const task of extraction.tasks) {
        try {
          const due = task.due_at ? parseDate(task.due_at) : null;
          if (task.due_at && !due) continue;
          this.tasks.create({
            title: task.title,
            dueAt: due ? due.toISOString() : null,
            recurrence: task.recurrence ?? null,
            source: 'conversation',
            channel: this.conversations.get(conversationId)?.channel,
          });
          tasks += 1;
        } catch (error) {
          this.logger.debug('task extraction item failed', {error: (error as Error).message});
        }
      }

      this.db.kvSet(key, String(maxRow));
      this.logger.info('consolidated conversation', {conversationId, memories, facts, tasks});
      return {memories, facts, tasks};
    } catch (error) {
      this.logger.warn('consolidation failed', {conversationId, error: (error as Error).message});
      return null;
    } finally {
      this.running.delete(conversationId);
    }
  }

  /** Summarize older messages when the transcript grows too large. */
  async summarizeIfNeeded(conversationId: string, keepRecent = 14): Promise<boolean> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return false;
    const rows = this.conversations.messages(conversationId, {limit: 400, afterRow: 0});
    if (rows.length <= keepRecent + 4) return false;
    const chars = rows.reduce((sum, row) => sum + (row.content?.length ?? 0), 0);
    if (chars < 36_000) return false;

    const older = rows.slice(0, Math.max(0, rows.length - keepRecent));
    const alreadySummarized = older.filter((row) => row.id <= conversation.summary_upto_message_row);
    const toSummarize = older.filter((row) => row.id > conversation.summary_upto_message_row);
    if (toSummarize.length < 4) return false;

    const transcript = [
      conversation.summary ? `Previous summary:\n${conversation.summary}` : '',
      ...toSummarize.map((row) => `${row.role.toUpperCase()}: ${(row.content ?? '').slice(0, 2500)}`),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 28_000);

    try {
      const result = await this.llm.small.complete({
        messages: [
          {role: 'system', content: SUMMARY_INSTRUCTIONS},
          {role: 'user', content: transcript},
        ],
        tools: [],
        temperature: 0.2,
        maxOutputTokens: 700,
      });
      const summary = result.text.trim();
      if (!summary) return false;
      const upto = toSummarize[toSummarize.length - 1]!.id;
      this.conversations.setSummary(conversationId, summary, upto);
      this.logger.info('conversation summarized', {
        conversationId,
        summarizedMessages: toSummarize.length,
        previouslySummarized: alreadySummarized.length,
      });
      return true;
    } catch (error) {
      this.logger.warn('summarization failed', {conversationId, error: (error as Error).message});
      return false;
    }
  }

  /** Periodic maintenance: prune expired memories and store a heartbeat. */
  maintenance(): void {
    const result = this.memory.prune();
    this.db.kvSet('maintenance:last_run', nowIso());
    if (result.expired || result.overflow) this.logger.info('memory maintenance', result);
  }
}

export {EXTRACTION_INSTRUCTIONS};
