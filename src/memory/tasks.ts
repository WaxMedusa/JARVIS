import {newId} from '../core/ids.js';
import {formatInTz, nowIso, parseDate} from '../core/time.js';
import type {JarvisConfig} from '../config.js';
import type {JarvisDB} from '../db/database.js';

export interface TaskRecord {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  recurrence: string | null;
  priority: number;
  status: string;
  channel: string | null;
  notified_at: string | null;
  source: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  notes?: string;
  dueAt?: string | null;
  recurrence?: string | null;
  priority?: number;
  channel?: string;
  source?: string;
}

/** Reminders and recurring tasks with a small, explicit recurrence grammar. */
export class TaskService {
  private readonly db: JarvisDB;
  private readonly config: JarvisConfig;

  constructor(options: {db: JarvisDB; config: JarvisConfig}) {
    this.db = options.db;
    this.config = options.config;
  }

  create(input: CreateTaskInput): TaskRecord {
    const title = input.title.trim();
    if (!title) throw new Error('Task title is required');
    const due = input.dueAt ? parseDate(input.dueAt) : null;
    if (input.dueAt && !due) throw new Error(`Could not parse due date: ${input.dueAt}`);
    const id = newId('task');
    this.db.run(
      `INSERT INTO tasks(id, title, notes, due_at, recurrence, priority, status, channel, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      title,
      input.notes ?? null,
      due ? due.toISOString() : null,
      input.recurrence ?? null,
      Math.min(3, Math.max(1, input.priority ?? 2)),
      input.channel ?? null,
      input.source ?? 'assistant',
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): TaskRecord | undefined {
    return this.db.get<TaskRecord>('SELECT * FROM tasks WHERE id = ?', id);
  }

  list(options: {status?: string; limit?: number; includeCompleted?: boolean; dueBefore?: string} = {}): TaskRecord[] {
    const limit = Math.min(options.limit ?? 50, 500);
    if (options.dueBefore) {
      return this.db.all<TaskRecord>(
        `SELECT * FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
        options.dueBefore,
        limit,
      );
    }
    if (options.status && options.status !== 'all') {
      return this.db.all<TaskRecord>('SELECT * FROM tasks WHERE status = ? ORDER BY COALESCE(due_at, created_at) ASC LIMIT ?', options.status, limit);
    }
    if (options.includeCompleted) {
      return this.db.all<TaskRecord>('SELECT * FROM tasks ORDER BY COALESCE(due_at, created_at) ASC LIMIT ?', limit);
    }
    return this.db.all<TaskRecord>(
      `SELECT * FROM tasks WHERE status = 'open' ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC LIMIT ?`,
      limit,
    );
  }

  update(id: string, patch: Partial<Pick<TaskRecord, 'title' | 'notes' | 'due_at' | 'recurrence' | 'priority' | 'status'>>): TaskRecord | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    this.db.run(
      `UPDATE tasks SET title = ?, notes = ?, due_at = ?, recurrence = ?, priority = ?, status = ? WHERE id = ?`,
      patch.title ?? task.title,
      patch.notes ?? task.notes,
      patch.due_at !== undefined ? patch.due_at : task.due_at,
      patch.recurrence !== undefined ? patch.recurrence : task.recurrence,
      patch.priority ?? task.priority,
      patch.status ?? task.status,
      id,
    );
    return this.get(id);
  }

  complete(id: string): TaskRecord | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    if (task.recurrence) return this.advance(task);
    this.db.run(`UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?`, nowIso(), id);
    return this.get(id);
  }

  cancel(id: string): boolean {
    return this.db.run(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`, id).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM tasks WHERE id = ?', id).changes > 0;
  }

  /** Advance a recurring task to its next occurrence after completion or notification. */
  advance(task: TaskRecord): TaskRecord {
    const base = parseDate(task.due_at) ?? new Date();
    const next = nextOccurrence(task.recurrence ?? '', base);
    if (!next) {
      this.db.run(`UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?`, nowIso(), task.id);
      return this.get(task.id)!;
    }
    this.db.run('UPDATE tasks SET due_at = ?, notified_at = NULL, status = ? WHERE id = ?', next.toISOString(), 'open', task.id);
    return this.get(task.id)!;
  }

  /** Open tasks whose due time has passed and which have not been announced. */
  due(now = new Date()): TaskRecord[] {
    return this.db.all<TaskRecord>(
      `SELECT * FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?
       AND (notified_at IS NULL OR notified_at < due_at) ORDER BY due_at ASC LIMIT 50`,
      now.toISOString(),
    );
  }

  markNotified(id: string, at = new Date()): void {
    this.db.run('UPDATE tasks SET notified_at = ? WHERE id = ?', at.toISOString(), id);
  }

  upcoming(days = 7, limit = 30): TaskRecord[] {
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    return this.db.all<TaskRecord>(
      `SELECT * FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?
       ORDER BY due_at ASC LIMIT ?`,
      until,
      limit,
    );
  }

  format(task: TaskRecord): string {
    const due = task.due_at ? ` — due ${formatInTz(task.due_at, this.config.assistant.timezone, {dateStyle: 'medium', timeStyle: 'short'})}` : '';
    const repeat = task.recurrence ? ` (repeats ${task.recurrence})` : '';
    const state = task.status !== 'open' ? ` [${task.status}]` : '';
    return `${task.id}: ${task.title}${due}${repeat}${state}`;
  }

  taskBlock(limit = 15): string {
    const tasks = this.list({limit});
    if (!tasks.length) return 'No open tasks or reminders.';
    return tasks
      .map((task) => `- ${this.format(task)}${task.notes ? ` — ${task.notes.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)
      .join('\n');
  }
}

/**
 * Recurrence grammar: daily, weekdays, weekly, monthly, hourly,
 * every:<n>:minutes|hours|days|weeks, or a comma-separated list of weekdays (mon,thu).
 */
export function nextOccurrence(recurrence: string, from: Date): Date | null {
  const spec = recurrence.trim().toLowerCase();
  if (!spec) return null;
  const base = new Date(from.getTime());

  if (spec === 'hourly') return new Date(base.getTime() + 3_600_000);
  if (spec === 'daily') return new Date(base.getTime() + 86_400_000);
  if (spec === 'weekly') return new Date(base.getTime() + 7 * 86_400_000);
  if (spec === 'monthly') {
    const next = new Date(base.getTime());
    const day = next.getUTCDate();
    next.setUTCMonth(next.getUTCMonth() + 1);
    if (next.getUTCDate() < day) next.setUTCDate(0);
    return next;
  }
  if (spec === 'weekdays') {
    let next = new Date(base.getTime() + 86_400_000);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next = new Date(next.getTime() + 86_400_000);
    return next;
  }

  const every = /^every:(\d+):(minutes?|hours?|days?|weeks?)$/.exec(spec);
  if (every) {
    const count = Math.max(1, Number(every[1]));
    const unit = every[2]!;
    const ms = unit.startsWith('minute')
      ? 60_000
      : unit.startsWith('hour')
        ? 3_600_000
        : unit.startsWith('day')
          ? 86_400_000
          : 7 * 86_400_000;
    return new Date(base.getTime() + count * ms);
  }

  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const days = spec
    .split(/[,\s]+/)
    .map((token) => weekdays.indexOf(token.slice(0, 3)))
    .filter((index) => index >= 0);
  if (days.length) {
    for (let offset = 1; offset <= 14; offset += 1) {
      const candidate = new Date(base.getTime() + offset * 86_400_000);
      if (days.includes(candidate.getUTCDay())) return candidate;
    }
  }
  return null;
}
