import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {globToRegExp} from '../security/policy.js';
import {defineTool} from './types.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', 'target', '.next', 'coverage']);

export const fileTools = [
  defineTool({
    name: 'list_files',
    description: 'List files and folders inside the allowed workspace. Use it to explore a directory before reading files.',
    risk: 'read',
    category: 'files',
    schema: z.object({
      path: z.string().describe('Directory path (absolute or ~/...)'),
      depth: z.number().int().min(1).max(5).default(2),
      limit: z.number().int().min(1).max(500).default(120),
    }),
    async handler(args, ctx) {
      const root = ctx.policy.assertPath(args.path, {mustExist: true});
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return {content: `${root} is not a directory.`, isError: true};
      const results: string[] = [];
      const walk = async (dir: string, level: number): Promise<void> => {
        if (results.length >= args.limit || level > args.depth) return;
        let entries;
        try {
          entries = await fs.readdir(dir, {withFileTypes: true});
        } catch {
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (results.length >= args.limit) return;
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const relative = path.relative(root, full) || entry.name;
          if (entry.isDirectory()) {
            results.push(`${relative}/`);
            await walk(full, level + 1);
          } else if (entry.isFile()) {
            const info = await fs.stat(full).catch(() => null);
            results.push(`${relative} (${formatBytes(info?.size ?? 0)})`);
          }
        }
      };
      await walk(root, 1);
      return {
        content: results.length ? `${root}\n${results.join('\n')}` : `${root} is empty.`,
        summary: `${results.length} entries`,
      };
    },
  }),

  defineTool({
    name: 'read_file',
    description: 'Read a text file (optionally a line range). Files must be inside the allowed workspace; binaries and huge files are rejected.',
    risk: 'read',
    category: 'files',
    schema: z.object({
      path: z.string(),
      start_line: z.number().int().min(1).default(1),
      end_line: z.number().int().min(1).optional(),
    }),
    async handler(args, ctx) {
      const file = ctx.policy.assertPath(args.path, {mustExist: true});
      const stat = await fs.stat(file);
      if (!stat.isFile()) return {content: `${file} is not a file.`, isError: true};
      if (stat.size > 2 * 1024 * 1024) return {content: `File is too large (${formatBytes(stat.size)}). Read it with a line range or shell tools.`, isError: true};
      const buffer = await fs.readFile(file);
      if (looksBinary(buffer)) return {content: 'Refusing to read a binary file.', isError: true};
      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      const start = Math.min(args.start_line, lines.length || 1);
      const end = Math.min(args.end_line ?? start + 399, lines.length, start + 499);
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((line, index) => `${start + index}: ${line}`).join('\n');
      const truncated = end < lines.length;
      return {
        content: `${file} (${lines.length} lines)${truncated ? `, showing ${start}-${end}` : ''}\n${numbered.slice(0, ctx.config.security.maxToolOutputChars)}`,
        summary: `${slice.length} lines`,
      };
    },
  }),

  defineTool({
    name: 'write_file',
    description: 'Write or append to a text file inside the allowed workspace. Creates parent directories. Use for notes, drafts and code the user asked you to save.',
    risk: 'write',
    category: 'files',
    schema: z.object({
      path: z.string(),
      content: z.string().max(300_000),
      mode: z.enum(['overwrite', 'append']).default('overwrite'),
    }),
    async handler(args, ctx) {
      const file = ctx.policy.assertPath(args.path, {forWrite: true});
      await fs.mkdir(path.dirname(file), {recursive: true});
      if (args.mode === 'append') await fs.appendFile(file, args.content, 'utf8');
      else await fs.writeFile(file, args.content, 'utf8');
      const stat = await fs.stat(file);
      return {
        content: `${args.mode === 'append' ? 'Appended' : 'Wrote'} ${args.content.length} chars to ${file} (${formatBytes(stat.size)} total).`,
        summary: `${args.mode} ${path.basename(file)}`,
      };
    },
  }),

  defineTool({
    name: 'search_files',
    description: 'Search file contents with a literal string or regular expression. Returns file, line number and matching text. Good for finding notes or code.',
    risk: 'read',
    category: 'files',
    schema: z.object({
      path: z.string().describe('Directory or file to search'),
      query: z.string().min(1).max(500),
      regex: z.boolean().default(false),
      file_pattern: z.string().optional().describe('Optional glob filter such as *.md'),
      max_results: z.number().int().min(1).max(200).default(40),
    }),
    timeoutMs: 120_000,
    async handler(args, ctx) {
      const root = ctx.policy.assertPath(args.path, {mustExist: true});
      let matcher: RegExp;
      try {
        matcher = args.regex ? new RegExp(args.query, 'i') : new RegExp(escapeRegExp(args.query), 'i');
      } catch (error) {
        return {content: `Invalid regular expression: ${(error as Error).message}`, isError: true};
      }
      const glob = args.file_pattern ? globToRegExp(args.file_pattern) : null;
      const matches: string[] = [];
      let scanned = 0;

      const searchFile = async (file: string): Promise<void> => {
        if (matches.length >= args.max_results) return;
        if (glob && !glob.test(path.basename(file))) return;
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size > 1024 * 1024) return;
        const buffer = await fs.readFile(file).catch(() => null);
        if (!buffer || looksBinary(buffer)) return;
        const lines = buffer.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && matches.length < args.max_results; i += 1) {
          if (matcher.test(lines[i]!)) matches.push(`${file}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`);
        }
      };

      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= args.max_results || scanned > 8000) return;
        let entries;
        try {
          entries = await fs.readdir(dir, {withFileTypes: true});
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= args.max_results || scanned > 8000) return;
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            scanned += 1;
            await searchFile(full);
          }
        }
      };

      const stat = await fs.stat(root);
      if (stat.isFile()) await searchFile(root);
      else await walk(root);

      return {
        content: matches.length ? matches.join('\n') : `No matches for "${args.query}" in ${root}.`,
        summary: `${matches.length} matches`,
      };
    },
  }),
];

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(8000, buffer.length));
  for (let i = 0; i < sample.length; i += 1) if (sample[i] === 0) return true;
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
