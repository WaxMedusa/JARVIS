import {z} from 'zod';
import type {NoteRecord} from '../memory/notes.js';
import {defineTool} from './types.js';

function formatNote(note: NoteRecord, includeContent = false): string {
  const tags = note.tags.length ? ` · ${note.tags.map((tag) => `#${tag}`).join(' ')}` : '';
  const flags = `${note.pinned ? ' · pinned' : ''}${note.archived ? ' · archived' : ''}${note.audio_mime ? ' · audio' : ''}`;
  const excerpt = note.content.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 420);
  const body = includeContent ? note.content : excerpt;
  return `${note.id}: ${note.title}${tags}${flags} (${note.updated_at.slice(0, 10)})\n${body}`;
}

export const noteTools = [
  defineTool({
    name: 'notes_create',
    description: 'Create a durable personal note. Use this for ideas, meeting notes, research snippets, decisions and anything the user wants to keep and search later.',
    risk: 'internal',
    category: 'notes',
    schema: z.object({
      title: z.string().max(200).optional().describe('Short title; derived from the content when omitted'),
      content: z.string().max(100_000).default(''),
      tags: z.array(z.string().max(40)).max(16).default([]).describe('Lowercase topics, e.g. work, ideas, health'),
      pinned: z.boolean().default(false),
    }),
    handler(args, ctx) {
      if (!args.title?.trim() && !args.content.trim()) return {content: 'A note needs a title or content.', isError: true};
      const note = ctx.notes.create({title: args.title, content: args.content, tags: args.tags, pinned: args.pinned, source: ctx.channel});
      return {content: `Note created: ${formatNote(note)}`, summary: 'note created', data: note};
    },
  }),

  defineTool({
    name: 'notes_search',
    description: 'Search notes and voice transcripts by keyword, or list recent notes. Use this before answering questions about something the user may have captured.',
    risk: 'read',
    category: 'notes',
    schema: z.object({
      query: z.string().max(300).optional().describe('Full-text query; omit to list recent notes'),
      tag: z.string().max(40).optional(),
      archived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    handler(args, ctx) {
      const notes = ctx.notes.list({query: args.query, tag: args.tag, archived: args.archived, limit: args.limit});
      if (!notes.length) return {content: 'No matching notes.', summary: 'no notes'};
      return {
        content: notes.map((note) => formatNote(note)).join('\n\n---\n\n'),
        summary: `${notes.length} notes`,
        data: notes.map((note) => note.id),
      };
    },
  }),

  defineTool({
    name: 'notes_get',
    description: 'Read the full content of a note by id or unique id prefix.',
    risk: 'read',
    category: 'notes',
    schema: z.object({id: z.string().min(3)}),
    handler(args, ctx) {
      const note = ctx.notes.resolve(args.id);
      if (!note) return {content: `No unique note matching "${args.id}".`, isError: true};
      return {content: formatNote(note, true), summary: 'note read', data: note};
    },
  }),

  defineTool({
    name: 'notes_update',
    description: 'Edit a note, append to it, change its tags, or pin/archive it. Use notes_append for additions so existing content is not replaced accidentally.',
    risk: 'internal',
    category: 'notes',
    schema: z.object({
      id: z.string().min(3),
      title: z.string().max(200).optional(),
      content: z.string().max(100_000).optional(),
      tags: z.array(z.string().max(40)).max(16).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    handler(args, ctx) {
      const note = ctx.notes.resolve(args.id);
      if (!note) return {content: `No unique note matching "${args.id}".`, isError: true};
      const updated = ctx.notes.update(note.id, {
        title: args.title,
        content: args.content,
        tags: args.tags,
        pinned: args.pinned,
        archived: args.archived,
      });
      return {content: `Note updated: ${formatNote(updated ?? note)}`, summary: 'note updated', data: updated};
    },
  }),

  defineTool({
    name: 'notes_append',
    description: 'Append a new paragraph to an existing note without replacing what is already there.',
    risk: 'internal',
    category: 'notes',
    schema: z.object({
      id: z.string().min(3),
      content: z.string().min(1).max(20_000),
    }),
    handler(args, ctx) {
      const note = ctx.notes.resolve(args.id);
      if (!note) return {content: `No unique note matching "${args.id}".`, isError: true};
      const separator = note.content.trim() ? '\n\n' : '';
      const updated = ctx.notes.update(note.id, {content: `${note.content}${separator}${args.content.trim()}`});
      return {content: `Appended to ${note.id} (${args.content.length} chars).`, summary: 'note appended', data: updated};
    },
  }),

  defineTool({
    name: 'notes_delete',
    description: 'Permanently delete a note and its audio attachment. Use only when the user explicitly asks to delete it.',
    risk: 'write',
    category: 'notes',
    schema: z.object({id: z.string().min(3)}),
    async handler(args, ctx) {
      const note = ctx.notes.resolve(args.id);
      if (!note) return {content: `No unique note matching "${args.id}".`, isError: true};
      const deleted = await ctx.notes.delete(note.id);
      return deleted
        ? {content: `Note "${note.title}" deleted.`, summary: 'note deleted'}
        : {content: 'Note could not be deleted.', isError: true};
    },
  }),
];
