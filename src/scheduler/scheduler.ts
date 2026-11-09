import type {JarvisConfig} from '../config.js';
import {errorMessage} from '../core/errors.js';
import {newId} from '../core/ids.js';
import {getLogger, type Logger} from '../core/logger.js';
import {dayKey, formatInTz, isQuietHours, minutesOfDay, nowIso, zonedParts} from '../core/time.js';
import type {JarvisDB} from '../db/database.js';
import type {Agent} from '../agent/agent.js';
import type {Consolidator} from '../memory/consolidation.js';
import type {DocumentIndex} from '../memory/documents.js';
import type {TaskService} from '../memory/tasks.js';
import type {Notifier} from '../tools/types.js';

interface JobRow {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
}

export interface SchedulerDeps {
  config: JarvisConfig;
  db: JarvisDB;
  tasks: TaskService;
  agent: Agent;
  notifier: Notifier;
  consolidator: Consolidator;
  documents: DocumentIndex;
}

/**
 * Runs inside the daemon: delivers reminders, generates morning/evening
 * briefings, executes user-defined cron prompts and performs maintenance.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly logger: Logger;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = true;
  private lastJobMinute = new Map<string, string>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.logger = getLogger().child('scheduler');
  }

  start(): void {
    if (this.stopped === false) return;
    this.stopped = false;
    this.seedJobs();
    this.schedule(5_000);
    this.logger.info('scheduler started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(30_000));
    }, delayMs);
    this.timer.unref?.();
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.deliverReminders(now);
      if (this.deps.config.proactive.enabled) {
        await this.runBriefings(now);
        await this.runCronJobs(now);
      }
      this.maintenance(now);
    } catch (error) {
      this.logger.warn('scheduler tick failed', {error: errorMessage(error)});
    } finally {
      this.ticking = false;
    }
  }

  private async deliverReminders(now: Date): Promise<void> {
    const due = this.deps.tasks.due(now);
    for (const task of due) {
      try {
        await this.deps.notifier.send({
          title: `Reminder: ${task.title}`,
          body: task.notes || `Due ${formatInTz(task.due_at ?? now, this.deps.config.assistant.timezone, {dateStyle: 'medium', timeStyle: 'short'})}`,
          channel: task.channel ?? undefined,
          meta: {taskId: task.id, priority: task.priority},
        });
        if (task.recurrence) this.deps.tasks.advance(task);
        else this.deps.tasks.markNotified(task.id, now);
        this.logger.info('reminder delivered', {taskId: task.id, title: task.title});
      } catch (error) {
        this.logger.warn('reminder delivery failed', {taskId: task.id, error: errorMessage(error)});
      }
    }
  }

  private async runBriefings(now: Date): Promise<void> {
    const config = this.deps.config;
    const tz = config.assistant.timezone;
    if (isQuietHours(now, tz, config.proactive.quietHours.start, config.proactive.quietHours.end)) return;
    const minutes = minutesOfDay(now, tz);
    const today = dayKey(now, tz);

    if (config.proactive.morningBrief && clockMatches(config.proactive.morningBrief, minutes)) {
      await this.runOncePerDay('morning_brief', today, `Morning briefing — ${formatInTz(now, tz, {dateStyle: 'full'})}`, MORNING_PROMPT);
    }
    if (config.proactive.eveningReview && clockMatches(config.proactive.eveningReview, minutes)) {
      await this.runOncePerDay('evening_review', today, 'Evening review', EVENING_PROMPT);
    }
    if (config.proactive.weeklyReviewCron && matchesCron(config.proactive.weeklyReviewCron, now, tz)) {
      await this.runOncePerDay('weekly_review', today, 'Weekly review', WEEKLY_PROMPT);
    }
  }

  private async runOncePerDay(key: string, today: string, title: string, prompt: string): Promise<void> {
    const marker = `proactive:${key}`;
    if (this.deps.db.kvGet(marker) === today) return;
    this.deps.db.kvSet(marker, today);
    await this.generateAndSend(key, title, prompt);
  }

  private async runCronJobs(now: Date): Promise<void> {
    const jobs = this.deps.db.all<JobRow>('SELECT * FROM jobs WHERE enabled = 1 AND cron IS NOT NULL');
    const tz = this.deps.config.assistant.timezone;
    const minuteKey = `${dayKey(now, tz)}T${String(minutesOfDay(now, tz)).padStart(4, '0')}`;
    for (const job of jobs) {
      if (!job.cron || !matchesCron(job.cron, now, tz)) continue;
      if (this.lastJobMinute.get(job.id) === minuteKey) continue;
      this.lastJobMinute.set(job.id, minuteKey);
      try {
        const result = await this.deps.agent.runToCompletion({
          message: job.prompt,
          channel: 'automation',
          consolidate: false,
          extraInstructions: 'This is an automated scheduled job. Execute it fully, then send the user a short result. Do not ask questions.',
        });
        await this.deps.notifier.send({
          title: job.name.replace(/_/g, ' '),
          body: result.text.slice(0, 3500) || 'Job completed with no output.',
          channel: job.channel || undefined,
        });
        this.deps.db.run('UPDATE jobs SET last_run_at = ?, last_status = ? WHERE id = ?', nowIso(), 'ok', job.id);
      } catch (error) {
        this.logger.warn('scheduled job failed', {job: job.name, error: errorMessage(error)});
        this.deps.db.run('UPDATE jobs SET last_run_at = ?, last_status = ? WHERE id = ?', nowIso(), 'error', job.id);
      }
    }
  }

  private async generateAndSend(key: string, title: string, prompt: string): Promise<void> {
    try {
      const result = await this.deps.agent.runToCompletion({
        message: prompt,
        channel: 'automation',
        consolidate: false,
        extraInstructions: 'This is a proactive scheduled briefing. Be brief, concrete and useful. Use tools to check the calendar, tasks and weather where available.',
      });
      await this.deps.notifier.send({title, body: result.text.slice(0, 3500)});
      this.deps.db.run('UPDATE jobs SET last_run_at = ?, last_status = ? WHERE name = ?', nowIso(), 'ok', key);
    } catch (error) {
      this.logger.warn('briefing failed', {key, error: errorMessage(error)});
      this.deps.db.run('UPDATE jobs SET last_run_at = ?, last_status = ? WHERE name = ?', nowIso(), 'error', key);
    }
  }

  private maintenance(now: Date): void {
    const today = dayKey(now, this.deps.config.assistant.timezone);
    if (this.deps.db.kvGet('maintenance:day') !== today) {
      this.deps.db.kvSet('maintenance:day', today);
      try {
        this.deps.consolidator.maintenance();
      } catch (error) {
        this.logger.warn('maintenance failed', {error: errorMessage(error)});
      }
    }

    const vault = this.deps.config.integrations.obsidian.vaultPath;
    if (this.deps.config.memory.autoIndexVault && vault) {
      const last = Number(this.deps.db.kvGet('index:last') ?? 0);
      if (Date.now() - last > 30 * 60_000) {
        this.deps.db.kvSet('index:last', String(Date.now()));
        void this.deps.documents
          .indexPath(vault)
          .then((stats) => {
            if (stats.indexed) this.logger.info('vault reindexed', {indexed: stats.indexed, chunks: stats.chunks});
          })
          .catch((error) => this.logger.warn('vault indexing failed', {error: errorMessage(error)}));
      }
    }
  }

  private seedJobs(): void {
    for (const job of this.deps.config.proactive.jobs) {
      this.deps.db.run(
        `INSERT INTO jobs(id, name, cron, prompt, channel, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?, 'prompt', ?, ?)
         ON CONFLICT(name) DO UPDATE SET cron = excluded.cron, prompt = excluded.prompt, channel = excluded.channel, enabled = excluded.enabled`,
        newId('job'),
        job.name,
        job.cron,
        job.prompt,
        job.channel,
        job.enabled ? 1 : 0,
        nowIso(),
      );
    }
  }
}

const MORNING_PROMPT = `Prepare my morning briefing. Check today's calendar, my open tasks and the weather for my home city. Then give me: (1) the schedule with times, (2) the three most important things to do today, (3) anything time-sensitive or conflicting, (4) a one-line weather note. Keep it under 200 words.`;
const EVENING_PROMPT = `Prepare my evening review. Check what was on my calendar today, which tasks are still open, and what is due tomorrow. Give me: (1) a two-line summary of the day, (2) unfinished items worth carrying over, (3) tomorrow's first commitment. Keep it under 120 words.`;
const WEEKLY_PROMPT = `Prepare my weekly review. Look at open tasks, recent conversations and the coming week's calendar. Summarise progress, flag neglected commitments, and suggest the three priorities for next week. Keep it under 220 words.`;

export function clockMatches(value: string, minutes: number): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const target = Number(match[1]) * 60 + Number(match[2]);
  return Math.abs(target - minutes) < 1;
}

/**
 * Standard 5-field cron matching in the configured timezone.
 * Supports *, lists, ranges and /step. Day-of-month and day-of-week use AND.
 */
export function matchesCron(expression: string, date: Date, timeZone: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const parts = zonedParts(date, timeZone);
  const candidates: Array<[string, number, number, number]> = [
    [fields[0]!, 0, 59, parts.minute],
    [fields[1]!, 0, 23, parts.hour],
    [fields[2]!, 1, 31, parts.day],
    [fields[3]!, 1, 12, parts.month],
    [fields[4]!, 0, 7, parts.weekday],
  ];
  for (const [field, min, max, actual] of candidates) {
    if (!fieldMatches(field, min, max, actual)) return false;
  }
  return true;
}

function fieldMatches(field: string, min: number, max: number, actual: number): boolean {
  if (field === '*' || field === '?') return true;
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isFinite(step) || step < 1) return false;
    let start = min;
    let end = max;
    if (rangePart && rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [from, to] = rangePart.split('-').map(Number);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
        start = from;
        end = to;
      } else {
        start = Number(rangePart);
        end = stepPart ? max : start;
        if (!Number.isFinite(start)) return false;
      }
    }
    const normalizedActual = max === 7 && actual === 0 ? 7 : actual;
    for (let value = start; value <= end; value += step) {
      if (value === normalizedActual || (max === 7 && value === 0 && actual === 0)) return true;
      if (max === 7 && value === 7 && actual === 0) return true;
    }
  }
  return false;
}
