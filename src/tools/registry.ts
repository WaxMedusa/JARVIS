import {z} from 'zod';
import {JarvisError, errorMessage} from '../core/errors.js';
import {getLogger} from '../core/logger.js';
import {truncateMiddle} from '../core/redact.js';
import type {ApprovalRequest, ToolContext, ToolDefinition, ToolExecution} from './types.js';

export interface RegisteredTool {
  definition: ToolDefinition;
  source: string;
  jsonSchema: Record<string, unknown>;
}

/** Tool catalog: validation, permissions, timeouts, auditing and output limits. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly logger = getLogger().child('tools');

  register<TSchema extends z.ZodType>(definition: ToolDefinition<TSchema>, source = 'builtin'): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name)) {
      throw new JarvisError('VALIDATION', `Invalid tool name: ${definition.name}`);
    }
    this.tools.set(definition.name, {
      definition: definition as ToolDefinition,
      source,
      jsonSchema: definition.jsonSchema ?? toJsonSchema(definition.schema),
    });
  }

  registerMany(definitions: Array<ToolDefinition<any>>, source = 'builtin'): void {
    for (const definition of definitions) this.register(definition, source);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }

  count(): number {
    return this.tools.size;
  }

  describe(): Array<{name: string; description: string; parameters: Record<string, unknown>}> {
    return this.list().map(({definition}) => ({
      name: definition.name,
      description: definition.usage ? `${definition.description}\n\n${definition.usage}` : definition.description,
      parameters: this.tools.get(definition.name)!.jsonSchema,
    }));
  }

  describeText(): string {
    return this.list()
      .map(({definition, source}) => `- ${definition.name} [${definition.risk}${source !== 'builtin' ? `, ${source}` : ''}] — ${definition.description}`)
      .join('\n');
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolExecution> {
    const started = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        tool: name,
        ok: false,
        content: `Unknown tool "${name}". Available tools: ${this.list().map((entry) => entry.definition.name).join(', ')}`,
        durationMs: 0,
        args: {},
      };
    }

    let args: Record<string, unknown>;
    try {
      args = normalizeArgs(rawArgs);
    } catch (error) {
      return {
        tool: name,
        ok: false,
        content: `Invalid arguments for ${name}: ${errorMessage(error)}`,
        durationMs: Date.now() - started,
        args: {},
      };
    }

    const parsed = tool.definition.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`).join('; ');
      return {
        tool: name,
        ok: false,
        content: `Argument validation failed for ${name}: ${issues}`,
        durationMs: Date.now() - started,
        args,
      };
    }
    const validArgs = parsed.data as Record<string, unknown>;

    const toolDecision = ctx.policy.checkTool({name, risk: tool.definition.risk});
    const argDecision = ctx.policy.checkToolArgs({name, risk: tool.definition.risk}, validArgs);
    const decision = toolDecision.action === 'deny' ? toolDecision : argDecision.action === 'deny' ? argDecision : toolDecision.action === 'ask' ? toolDecision : argDecision;

    if (decision.action === 'deny') {
      ctx.audit.record('policy', 'tool.denied', {tool: name, args: validArgs, reason: decision.reason});
      return {
        tool: name,
        ok: false,
        denied: true,
        content: `Permission denied: ${decision.reason}`,
        durationMs: Date.now() - started,
        args: validArgs,
      };
    }

    if (decision.action === 'ask') {
      const request: ApprovalRequest = {
        tool: name,
        risk: tool.definition.risk,
        summary: summarizeCall(name, validArgs),
        args: validArgs,
        reason: decision.reason,
      };
      const approved = ctx.requestApproval ? await ctx.requestApproval(request) : false;
      if (!approved) {
        ctx.audit.record('user', 'tool.rejected', {tool: name, args: validArgs, reason: decision.reason});
        return {
          tool: name,
          ok: false,
          denied: true,
          content: `The user did not approve this action (${decision.reason}). Do not retry unless the user asks.`,
          durationMs: Date.now() - started,
          args: validArgs,
        };
      }
      ctx.audit.record('user', 'tool.approved', {tool: name, args: validArgs});
    }

    const timeoutMs = tool.definition.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onAbort, {once: true});
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const timeoutGuard = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new JarvisError(timedOut ? 'TIMEOUT' : 'TIMEOUT', timedOut ? `Tool ${name} timed out after ${timeoutMs}ms` : 'Tool execution aborted'));
        }, {once: true});
      });
      const result = await Promise.race([
        tool.definition.handler(parsed.data, {...ctx, signal: controller.signal}),
        timeoutGuard,
      ]);
      const normalized = typeof result === 'string' ? {content: result} : result;
      const content = truncateMiddle(normalized.content ?? '', ctx.config.security.maxToolOutputChars);
      ctx.audit.record('assistant', 'tool.executed', {tool: name, args: validArgs, ok: !normalized.isError, chars: content.length});
      return {
        tool: name,
        ok: !normalized.isError,
        content,
        summary: normalized.summary,
        durationMs: Date.now() - started,
        args: validArgs,
      };
    } catch (error) {
      const message = errorMessage(error);
      const isTimeout = timedOut || message.toLowerCase().includes('timed out');
      this.logger.warn('tool failed', {tool: name, error: message, timeout: isTimeout});
      ctx.audit.record('assistant', 'tool.failed', {tool: name, args: validArgs, error: message});
      return {
        tool: name,
        ok: false,
        content: `${name} failed: ${isTimeout ? `timed out after ${timeoutMs}ms` : message}`,
        durationMs: Date.now() - started,
        args: validArgs,
      };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeArgs(parsed);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('arguments must be a JSON object');
  return raw as Record<string, unknown>;
}

function summarizeCall(name: string, args: Record<string, unknown>): string {
  const important = ['path', 'command', 'url', 'to', 'subject', 'title', 'query', 'id', 'summary'];
  const pieces: string[] = [];
  for (const key of important) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) pieces.push(`${key}=${value.length > 80 ? `${value.slice(0, 77)}…` : value}`);
  }
  return pieces.length ? `${name} (${pieces.join(', ')})` : name;
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema, {target: 'draft-7', io: 'input'}) as Record<string, unknown>;
    const {['$schema']: _schema, ...rest} = json;
    return rest;
  } catch {
    return {type: 'object', additionalProperties: true};
  }
}
