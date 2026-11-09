import {z} from 'zod';
import {formatInTz, parseDate} from '../core/time.js';
import type {TaskRecord} from '../memory/tasks.js';
import {buildFtsQuery} from '../memory/memory.js';
import {defineTool} from './types.js';

const TaskRecurrence = z
  .string()
  .nullable()
  .optional()
  .describe('Optional recurrence: daily, weekdays, weekly, monthly, hourly, every:2:weeks, or mon,wed,fri');

export const memoryTools = [
  defineTool({
    name: 'remember',
    description:
      'Store a durable piece of information in long-term memory: a preference, decision, event, person, project detail or insight. Use this for anything worth recalling weeks later. Identical content is de-duplicated.',
    risk: 'internal',
    category: 'memory',
    schema: z.object({
      content: z.string().min(3).max(4000).describe('Self-contained statement, understandable without the current conversation'),
      kind: z.enum(['note', 'fact', 'event', 'preference', 'insight', 'person', 'project']).default('note'),
      importance: z.number().min(0).max(1).default(0.5).describe('0.2 trivial, 0.5 normal, 0.9 core life detail'),
      sensitivity: z.enum(['public', 'private', 'secret']).default('private'),
      pinned: z.boolean().default(false).describe('Pinned memories are always easy to recall'),
    }),
    async handler(args, ctx) {
      const record = await ctx.memory.remember({
        content: args.content,
        kind: args.kind,
        importance: args.importance,
        sensitivity: args.sensitivity,
        pinned: args.pinned,
        source: ctx.channel,
        sourceRef: ctx.conversationId,
      });
      return {content: `Stored in memory as ${record.id}.`, summary: 'memory stored', data: {id: record.id}};
    },
  }),

  defineTool({
    name: 'recall',
    description:
      'Search long-term memory (semantic + keyword + recency). Use before answering personal questions, and to check whether you already know something about the user.',
    risk: 'read',
    category: 'memory',
    schema: z.object({
      query: z.string().min(1).describe('What to recall, phrased as a topic or question'),
      limit: z.number().int().min(1).max(25).default(8),
      kinds: z.array(z.string()).default([]).describe('Optional filter: note, fact, event, preference, insight, person, project'),
    }),
    async handler(args, ctx) {
      const hits = await ctx.memory.search(args.query, {limit: args.limit, kinds: args.kinds.length ? args.kinds : undefined});
      if (!hits.length) return {content: 'No matching memories.', summary: 'no memories found'};
      const lines = hits.map(
        (hit) =>
          `[${hit.memory.id}] (${formatInTz(hit.memory.created_at, ctx.config.assistant.timezone, {dateStyle: 'medium'})}, ${hit.memory.kind}, relevance ${(hit.score * 100).toFixed(0)}%) ${hit.memory.content}`,
      );
      return {content: lines.join('\n'), summary: `${hits.length} memories`, data: hits.map((hit) => hit.memory.id)};
    },
  }),

  defineTool({
    name: 'search_history',
    description: 'Search past conversations with the user. Use for "what did we decide about X" or to reconstruct prior context.',
    risk: 'read',
    category: 'memory',
    schema: z.object({
      query: z.string().min(2),
      limit: z.number().int().min(1).max(30).default(10),
    }),
    handler(args, ctx) {
      const ftsQuery = buildFtsQuery(args.query);
      if (!ftsQuery) return {content: 'Query had no usable search terms.', isError: true};
      try {
        const rows = ctx.db.all<{role: string; content: string; created_at: string; title: string | null}>(
          `SELECT m.role, m.content, m.created_at, c.title FROM messages_fts f
           JOIN messages m ON m.id = f.rowid LEFT JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
          ftsQuery,
          args.limit,
        );
        if (!rows.length) return {content: 'No matching conversation history.', summary: 'no history'};
        const lines = rows.map(
          (row) =>
            `- (${formatInTz(row.created_at, ctx.config.assistant.timezone, {dateStyle: 'medium'})} · ${row.title ?? 'conversation'} · ${row.role}): ${(row.content ?? '').replace(/\s+/g, ' ').slice(0, 700)}`,
        );
        return {content: lines.join('\n'), summary: `${rows.length} transcript matches`};
      } catch (error) {
        return {content: `History search failed: ${(error as Error).message}`, isError: true};
      }
    },
  }),

  defineTool({
    name: 'update_profile',
    description:
      'Create or update a stable attribute about the user (name, home city, job, relationships, routines, goals, preferences). Previous values are kept as history when a value changes.',
    risk: 'internal',
    category: 'memory',
    schema: z.object({
      key: z.string().min(1).max(80).describe('Stable snake_case slot, e.g. home_city, job_title, dietary_preference'),
      value: z.string().min(1).max(600),
      category: z.enum(['identity', 'location', 'work', 'health', 'relationships', 'preferences', 'goals', 'projects', 'finance', 'general']).default('general'),
      confidence: z.number().min(0).max(1).default(0.9),
      sensitivity: z.enum(['public', 'private', 'secret']).default('private'),
    }),
    async handler(args, ctx) {
      const result = await ctx.memory.setFact({
        key: args.key,
        value: args.value,
        category: args.category,
        confidence: args.confidence,
        source: ctx.channel,
        sensitivity: args.sensitivity,
      });
      const note = result.superseded ? ` (previous value "${result.superseded.value}" archived)` : '';
      return {content: `Profile updated: ${result.fact.key} = ${result.fact.value}${note}`, summary: 'profile updated', data: result.fact};
    },
  }),

  defineTool({
    name: 'get_profile',
    description: 'Read the stored profile facts about the user. Optionally filter by category.',
    risk: 'read',
    category: 'memory',
    schema: z.object({
      category: z.enum(['identity', 'location', 'work', 'health', 'relationships', 'preferences', 'goals', 'projects', 'finance', 'general']).optional(),
    }),
    handler(args, ctx) {
      const facts = ctx.memory.getProfile({category: args.category, limit: 200});
      if (!facts.length) return {content: 'No profile facts stored yet.', summary: 'empty profile'};
      return {
        content: facts.map((fact) => `- ${fact.category}/${fact.key}: ${fact.value} (confidence ${fact.confidence.toFixed(2)})`).join('\n'),
        summary: `${facts.length} facts`,
      };
    },
  }),

  defineTool({
    name: 'forget_memory',
    description: 'Permanently delete a memory by id. Use only when the user explicitly asks you to forget something.',
    risk: 'write',
    category: 'memory',
    schema: z.object({id: z.string().min(3).describe('Memory id, e.g. mem_abc123')}),
    handler(args, ctx) {
      const deleted = ctx.memory.delete(args.id);
      return deleted
        ? {content: `Memory ${args.id} deleted.`, summary: 'memory deleted'}
        : {content: `No memory found with id ${args.id}.`, isError: true};
    },
  }),

  defineTool({
    name: 'create_task',
    description:
      'Create a task or reminder. Convert relative dates to an ISO-8601 timestamp with offset in the user\'s timezone before calling. Use recurrence for repeating reminders.',
    risk: 'internal',
    category: 'tasks',
    schema: z.object({
      title: z.string().min(1).max(300),
      due_at: z.string().nullable().optional().describe('ISO-8601 timestamp with offset, e.g. 2026-11-10T09:00:00+01:00'),
      notes: z.string().max(2000).nullable().optional(),
      recurrence: TaskRecurrence,
      priority: z.number().int().min(1).max(3).default(2).describe('1 high, 2 normal, 3 low'),
    }),
    handler(args, ctx) {
      if (args.due_at && !parseDate(args.due_at)) return {content: `Invalid due_at: ${args.due_at}. Use ISO-8601.`, isError: true};
      const task = ctx.tasks.create({
        title: args.title,
        dueAt: args.due_at ?? null,
        notes: args.notes ?? undefined,
        recurrence: args.recurrence ?? null,
        priority: args.priority,
        channel: ctx.channel,
        source: 'assistant',
      });
      return {content: `Task created: ${ctx.tasks.format(task)}`, summary: 'task created', data: task};
    },
  }),

  defineTool({
    name: 'list_tasks',
    description: 'List tasks and reminders. Defaults to open tasks, soonest first.',
    risk: 'read',
    category: 'tasks',
    schema: z.object({
      status: z.enum(['open', 'done', 'cancelled', 'all']).default('open'),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    handler(args, ctx) {
      const tasks = ctx.tasks.list({status: args.status, includeCompleted: args.status === 'all', limit: args.limit});
      if (!tasks.length) return {content: 'No tasks found.', summary: 'no tasks'};
      return {content: tasks.map((task) => ctx.tasks.format(task)).join('\n'), summary: `${tasks.length} tasks`};
    },
  }),

  defineTool({
    name: 'complete_task',
    description: 'Mark a task or reminder complete. Recurring tasks automatically advance to their next occurrence.',
    risk: 'internal',
    category: 'tasks',
    schema: z.object({id: z.string().min(3).describe('Task id or unique prefix')}),
    handler(args, ctx) {
      const task = resolveTask(ctx.tasks, args.id);
      if (!task) return {content: `No unique task matching "${args.id}".`, isError: true};
      const updated = ctx.tasks.complete(task.id);
      return {content: `Task completed: ${updated ? ctx.tasks.format(updated) : task.title}`, summary: 'task completed'};
    },
  }),

  defineTool({
    name: 'update_task',
    description: 'Change a task\'s title, notes, due date, recurrence or status.',
    risk: 'internal',
    category: 'tasks',
    schema: z.object({
      id: z.string().min(3),
      title: z.string().min(1).max(300).optional(),
      notes: z.string().max(2000).optional(),
      due_at: z.string().optional().nullable(),
      recurrence: z.string().optional().nullable(),
      status: z.enum(['open', 'done', 'cancelled']).optional(),
      priority: z.number().int().min(1).max(3).optional(),
    }),
    handler(args, ctx) {
      const task = resolveTask(ctx.tasks, args.id);
      if (!task) return {content: `No unique task matching "${args.id}".`, isError: true};
      let due = task.due_at;
      if (args.due_at !== undefined) {
        if (args.due_at === null) due = null;
        else {
          const parsed = parseDate(args.due_at);
          if (!parsed) return {content: `Invalid due_at: ${args.due_at}`, isError: true};
          due = parsed.toISOString();
        }
      }
      const updated = ctx.tasks.update(task.id, {
        title: args.title,
        notes: args.notes,
        due_at: due,
        recurrence: args.recurrence,
        status: args.status,
        priority: args.priority,
      });
      return {content: `Task updated: ${updated ? ctx.tasks.format(updated) : task.id}`, summary: 'task updated'};
    },
  }),
];

function resolveTask(tasks: {get(id: string): TaskRecord | undefined; list(opts: {status: string; limit: number}): TaskRecord[]}, idOrPrefix: string): TaskRecord | undefined {
  const exact = tasks.get(idOrPrefix);
  if (exact) return exact;
  const matches = tasks.list({status: 'all', limit: 500}).filter((task) => task.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}
