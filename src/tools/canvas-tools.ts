import {z} from 'zod';
import type {CanvasService} from '../integrations/types.js';
import {defineTool, type ToolContext} from './types.js';

function canvas(ctx: ToolContext): CanvasService {
  const service = ctx.integrations.services.canvas;
  if (!service) {
    throw new Error('Canvas is not connected. Open JARVIS → School and add your Canvas URL and API token.');
  }
  return service;
}

function dueLabel(value?: string): string {
  if (!value) return 'no due date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

export const canvasTools = [
  defineTool({
    name: 'canvas_courses',
    description: 'List the Canvas LMS courses the user is enrolled in, with course ids used by the other Canvas tools.',
    risk: 'read',
    category: 'school',
    timeoutMs: 30_000,
    schema: z.object({}),
    async handler(_args, ctx) {
      const courses = await canvas(ctx).courses();
      if (!courses.length) return {content: 'No active Canvas courses.', summary: 'no courses'};
      return {
        content: courses
          .map((course) => `- ${course.name}${course.courseCode ? ` (${course.courseCode})` : ''} · id ${course.id}${course.term ? ` · ${course.term}` : ''}`)
          .join('\n'),
        summary: `${courses.length} courses`,
      };
    },
  }),

  defineTool({
    name: 'canvas_assignments',
    description: 'List Canvas assignments for one course, including due dates, points and submission state.',
    risk: 'read',
    category: 'school',
    timeoutMs: 30_000,
    schema: z.object({
      course_id: z.string().min(1).describe('Canvas course id from canvas_courses'),
      bucket: z.enum(['upcoming', 'future', 'past', 'undated']).default('upcoming'),
    }),
    async handler(args, ctx) {
      const assignments = await canvas(ctx).assignments(args.course_id, args.bucket);
      if (!assignments.length) return {content: 'No assignments in that bucket.', summary: 'no assignments'};
      return {
        content: assignments
          .map(
            (assignment) =>
              `- ${assignment.name} · due ${dueLabel(assignment.dueAt)}${assignment.points ? ` · ${assignment.points} pts` : ''}${assignment.submitted ? ' · submitted' : ''}${assignment.url ? ` — ${assignment.url}` : ''}`,
          )
          .join('\n'),
        summary: `${assignments.length} assignments`,
      };
    },
  }),

  defineTool({
    name: 'canvas_upcoming',
    description: 'List upcoming Canvas work across every active course, ordered by due date. Use for planning and daily briefings.',
    risk: 'read',
    category: 'school',
    timeoutMs: 60_000,
    schema: z.object({limit: z.number().int().min(1).max(50).default(20)}),
    async handler(args, ctx) {
      const assignments = await canvas(ctx).upcoming(args.limit);
      if (!assignments.length) return {content: 'No upcoming Canvas assignments.', summary: 'nothing due'};
      return {
        content: assignments
          .map(
            (assignment) =>
              `- ${assignment.courseName}: ${assignment.name} · due ${dueLabel(assignment.dueAt)}${assignment.submitted ? ' · submitted' : ''}`,
          )
          .join('\n'),
        summary: `${assignments.length} upcoming`,
      };
    },
  }),

  defineTool({
    name: 'canvas_todo',
    description: 'List the Canvas todo list (grading, submissions and other outstanding items).',
    risk: 'read',
    category: 'school',
    timeoutMs: 30_000,
    schema: z.object({limit: z.number().int().min(1).max(50).default(20)}),
    async handler(args, ctx) {
      const items = await canvas(ctx).todo(args.limit);
      if (!items.length) return {content: 'The Canvas todo list is clear.', summary: 'nothing todo'};
      return {
        content: items
          .map((item) => `- [${item.type}] ${item.title}${item.courseName ? ` · ${item.courseName}` : ''} · ${dueLabel(item.dueAt)}`)
          .join('\n'),
        summary: `${items.length} items`,
      };
    },
  }),
];
