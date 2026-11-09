import {spawn} from 'node:child_process';
import {z} from 'zod';
import {defineTool} from './types.js';

const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'PWD', 'DISPLAY']);

export const shellTools = [
  defineTool({
    name: 'run_shell',
    description:
      'Run a short shell command inside the allowed workspace and return stdout/stderr. Prefer dedicated tools when possible. Destructive commands are blocked; non-allowlisted commands require user approval.',
    risk: 'execute',
    category: 'shell',
    timeoutMs: 120_000,
    schema: z.object({
      command: z.string().min(1).max(2000),
      cwd: z.string().optional().describe('Working directory inside the allowed workspace'),
      timeout_ms: z.number().int().min(1000).max(120_000).default(30_000),
    }),
    async handler(args, ctx) {
      const cwd = args.cwd ? ctx.policy.assertPath(args.cwd, {mustExist: true}) : ctx.policy.allowedRoots.find(Boolean) ?? process.cwd();
      const started = Date.now();
      const result = await runProcess(args.command, cwd, args.timeout_ms, ctx.signal);
      const header = `exit=${result.code}${result.timedOut ? ' (timed out)' : ''} · ${Date.now() - started}ms · cwd=${cwd}`;
      const output = [
        header,
        result.stdout.trim() ? `--- stdout ---\n${result.stdout.trim()}` : '',
        result.stderr.trim() ? `--- stderr ---\n${result.stderr.trim()}` : '',
        result.truncated ? '[output truncated]' : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        content: output.slice(0, ctx.config.security.maxToolOutputChars),
        isError: result.code !== 0 || result.timedOut,
        summary: `exit ${result.code}`,
      };
    },
  }),
];

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

function runProcess(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {CI: '1', NO_COLOR: '1'};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && SAFE_ENV_KEYS.has(key)) env[key] = value;
    }
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const maxBytes = 60_000;

    const collect = (chunk: Buffer, into: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8');
      if (into === 'stdout') {
        if (stdout.length + text.length > maxBytes) {
          stdout += text.slice(0, Math.max(0, maxBytes - stdout.length));
          truncated = true;
        } else stdout += text;
      } else if (stderr.length + text.length > maxBytes) {
        stderr += text.slice(0, Math.max(0, maxBytes - stderr.length));
        truncated = true;
      } else stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));

    const killTree = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = (): void => killTree();
    signal?.addEventListener('abort', onAbort, {once: true});

    const finish = (code: number): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({code, stdout, stderr, timedOut, truncated});
    };

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
