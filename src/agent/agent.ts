import type {JarvisConfig} from '../config.js';
import {isAbortError, JarvisError, errorMessage} from '../core/errors.js';
import {getLogger, type Logger} from '../core/logger.js';
import {shortHash} from '../core/ids.js';
import type {LLMMessage, LLMUsage, ToolCall} from '../llm/types.js';
import type {LLMSet} from '../llm/index.js';
import type {Consolidator} from '../memory/consolidation.js';
import type {ApprovalRequest, ToolContext} from '../tools/types.js';
import type {ToolRegistry} from '../tools/registry.js';
import {ContextBuilder} from './context.js';

export type AgentEvent =
  | {type: 'start'; conversationId: string; channel: string}
  | {type: 'text'; text: string}
  | {type: 'reasoning'; text: string}
  | {type: 'tool_start'; name: string; args: Record<string, unknown>; risk: string}
  | {type: 'tool_end'; name: string; ok: boolean; summary?: string; durationMs: number; content: string}
  | {type: 'usage'; usage: LLMUsage}
  | {type: 'done'; conversationId: string; text: string; usage: LLMUsage; steps: number; toolCalls: number}
  | {type: 'error'; message: string; code?: string};

export type AgentDeps = Omit<ToolContext, 'channel' | 'conversationId' | 'signal' | 'requestApproval' | 'delegate'> & {
  registry: ToolRegistry;
  consolidator: Consolidator;
  context: ContextBuilder;
};

export interface RunOptions {
  message: string;
  conversationId?: string;
  channel?: string;
  signal?: AbortSignal;
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  maxSteps?: number;
  /** Restrict the tools visible to this turn (used by the research sub-agent). */
  toolFilter?: Set<string>;
  /** Skip memory extraction for this turn (sub-agents, automations). */
  consolidate?: boolean;
  /** Extra instructions appended to the system prompt for this turn. */
  extraInstructions?: string;
}

export interface RunResult {
  conversationId: string;
  text: string;
  usage: LLMUsage;
  steps: number;
  toolCalls: number;
}

/**
 * The reasoning loop: context -> model -> tools -> context, bounded by steps,
 * with approval gating, repeated-call detection and durable transcript.
 */
export class Agent {
  private readonly deps: AgentDeps;
  private readonly config: JarvisConfig;
  private readonly logger: Logger;
  private researchRunner?: (task: string, context?: string) => Promise<string>;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.logger = getLogger().child('agent');
    this.researchRunner = (task, context) => this.runResearch(task, context);
  }

  setResearchRunner(runner: (task: string, context?: string) => Promise<string>): void {
    this.researchRunner = runner;
  }

  async runToCompletion(options: RunOptions): Promise<RunResult> {
    let text = '';
    let conversationId = options.conversationId ?? '';
    let usage: LLMUsage = {inputTokens: 0, outputTokens: 0};
    let steps = 0;
    let toolCalls = 0;
    for await (const event of this.run(options)) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'start') conversationId = event.conversationId;
      else if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'done') {
        text = event.text || text;
        usage = event.usage;
        steps = event.steps;
        toolCalls = event.toolCalls;
      }
    }
    return {conversationId, text, usage, steps, toolCalls};
  }

  async *run(options: RunOptions): AsyncGenerator<AgentEvent, void, void> {
    const channel = options.channel ?? 'cli';
    const conversation = this.deps.conversations.getOrCreate(options.conversationId, channel);
    this.deps.conversations.append(conversation.id, {role: 'user', content: options.message});
    yield {type: 'start', conversationId: conversation.id, channel};
    this.logger.info('turn started', {conversationId: conversation.id, channel, chars: options.message.length});

    const toolDescriptors = this.deps.registry
      .describe()
      .filter((tool) => !options.toolFilter || options.toolFilter.has(tool.name));
    const toolNames = toolDescriptors.map((tool) => tool.name);
    const maxSteps = Math.min(options.maxSteps ?? this.config.llm.maxSteps, 40);
    const repeated = new Map<string, number>();
    const usageTotal: LLMUsage = {inputTokens: 0, outputTokens: 0};
    let finalText = '';
    let toolCallTotal = 0;
    let steps = 0;
    let finished = false;

    try {
      while (steps < maxSteps) {
        steps += 1;
        if (options.signal?.aborted) throw new JarvisError('TIMEOUT', 'Turn aborted');
        const context = await this.deps.context.build({
          conversationId: conversation.id,
          channel,
          userMessage: options.message,
          toolNames,
          integrationSummary: integrationSummary(this.deps),
          extraInstructions: options.extraInstructions,
        });

        const stepText: string[] = [];
        const calls: ToolCall[] = [];
        let stepUsage: LLMUsage = {inputTokens: 0, outputTokens: 0};
        let finishReason = 'stop';
        const request: LLMMessage[] = ContextBuilder.withSystem(context.system, context.messages);

        for await (const event of this.deps.llm.main.stream({
          messages: request,
          tools: toolDescriptors,
          temperature: this.config.llm.temperature,
          maxOutputTokens: this.config.llm.maxOutputTokens,
          abortSignal: options.signal,
        })) {
          if (event.type === 'text') {
            stepText.push(event.text);
            yield {type: 'text', text: event.text};
          } else if (event.type === 'reasoning') {
            yield {type: 'reasoning', text: event.text};
          } else if (event.type === 'tool_call') {
            calls.push(event.call);
          } else if (event.type === 'usage') {
            stepUsage = event.usage;
          } else if (event.type === 'done') {
            finishReason = event.finishReason;
          }
        }

        usageTotal.inputTokens += stepUsage.inputTokens;
        usageTotal.outputTokens += stepUsage.outputTokens;
        yield {type: 'usage', usage: usageTotal};

        const assistantText = stepText.join('');
        if (!calls.length) {
          finalText = assistantText;
          const content = finalText.trim() || '(no response)';
          this.deps.conversations.append(conversation.id, {
            role: 'assistant',
            content,
            tokens: stepUsage.outputTokens,
            metadata: {finishReason},
          });
          finalText = content;
          finished = true;
          break;
        }

        this.deps.conversations.append(conversation.id, {
          role: 'assistant',
          content: assistantText,
          toolCalls: calls,
          tokens: stepUsage.outputTokens,
          metadata: {finishReason},
        });

        const executions = await this.executeToolCalls(calls, conversation.id, channel, options, repeated);
        toolCallTotal += calls.length;
        for (const event of executions.events) yield event;
        if (executions.error) throw new JarvisError('TOOL_ERROR', executions.error);
      }

      if (!finished) {
        const note = '\n\nI reached my action limit for this turn. Tell me to continue and I will pick up where I left off.';
        finalText += note;
        yield {type: 'text', text: note};
        this.deps.conversations.append(conversation.id, {role: 'assistant', content: note.trim()});
      }

      yield {
        type: 'done',
        conversationId: conversation.id,
        text: finalText.trim(),
        usage: usageTotal,
        steps,
        toolCalls: toolCallTotal,
      };

      if (options.consolidate !== false && this.config.memory.extractFacts) {
        void this.deps.consolidator.afterTurn(conversation.id).catch((error) => {
          this.logger.warn('background consolidation failed', {error: errorMessage(error)});
        });
        void this.deps.consolidator.summarizeIfNeeded(conversation.id).catch((error) => {
          this.logger.warn('background summarization failed', {error: errorMessage(error)});
        });
      }
    } catch (error) {
      if (isAbortError(error) || (error instanceof JarvisError && error.code === 'TIMEOUT')) {
        yield {type: 'error', message: 'Turn cancelled.', code: 'TIMEOUT'};
        return;
      }
      this.logger.error('turn failed', {conversationId: conversation.id, error: errorMessage(error)});
      yield {type: 'error', message: errorMessage(error), code: error instanceof JarvisError ? error.code : 'INTERNAL'};
    }
  }

  /** Research sub-agent with read-only/web tools and an isolated conversation. */
  async research(task: string, context?: string): Promise<string> {
    if (!this.researchRunner) throw new Error('Research runner is not available');
    return this.researchRunner(task, context);
  }

  async runResearch(task: string, context?: string): Promise<string> {
    const filter = new Set(
      this.deps.registry
        .list()
        .filter(
          ({definition}) =>
            ['read', 'external'].includes(definition.risk) &&
            definition.name !== 'delegate_research' &&
            !definition.name.startsWith('mcp_'),
        )
        .map(({definition}) => definition.name),
    );
    const conversation = this.deps.conversations.create('subagent', `Research: ${task.slice(0, 60)}`);
    const result = await this.runToCompletion({
      message: `Research task: ${task}\n\n${context ? `Additional context:\n${context}\n\n` : ''}Gather evidence with your tools and return a compact factual report with source URLs. Do not modify memory, files, tasks or external systems.`,
      conversationId: conversation.id,
      channel: 'subagent',
      toolFilter: filter,
      maxSteps: 6,
      consolidate: false,
      extraInstructions:
        'You are a focused research sub-agent working for the main assistant. You have read-only tools. Be exhaustive but concise, cite source URLs for factual claims, and state clearly when evidence is missing. Never modify anything.',
    });
    return result.text;
  }

  private buildToolContext(conversationId: string, channel: string, options: RunOptions, signal?: AbortSignal): ToolContext {
    return {
      ...this.deps,
      channel,
      conversationId,
      signal,
      requestApproval: options.requestApproval,
      delegate: this.researchRunner ? (request) => this.research(request.task, request.context) : undefined,
    };
  }

  private async executeToolCalls(
    calls: ToolCall[],
    conversationId: string,
    channel: string,
    options: RunOptions,
    repeated: Map<string, number>,
  ): Promise<{events: AgentEvent[]; error?: string}> {
    const context = this.buildToolContext(conversationId, channel, options, options.signal);
    const events: AgentEvent[] = [];
    let index = 0;
    while (index < calls.length) {
      const call = calls[index]!;
      const parsed = parseArgs(call.arguments);
      const tool = this.deps.registry.get(call.name);
      const parallelizable = tool && canRunInParallel(tool.definition.risk, call.name, parsed, context);

      if (parallelizable) {
        const group: ToolCall[] = [call];
        let cursor = index + 1;
        while (cursor < calls.length && group.length < this.config.llm.maxParallelTools) {
          const candidate = calls[cursor]!;
          const candidateTool = this.deps.registry.get(candidate.name);
          const candidateArgs = parseArgs(candidate.arguments);
          if (!candidateTool || !canRunInParallel(candidateTool.definition.risk, candidate.name, candidateArgs, context)) break;
          group.push(candidate);
          cursor += 1;
        }
        const results = await Promise.all(group.map((item) => this.executeOne(item, conversationId, context, options, repeated, events)));
        for (const result of results) {
          if (result.error) return {events, error: result.error};
        }
        index += group.length;
        continue;
      }

      const result = await this.executeOne(call, conversationId, context, options, repeated, events);
      if (result.error) return {events, error: result.error};
      index += 1;
    }
    return {events};
  }

  private async executeOne(
    call: ToolCall,
    conversationId: string,
    context: ToolContext,
    options: RunOptions,
    repeated: Map<string, number>,
    events: AgentEvent[],
  ): Promise<{error?: string}> {
    const args = parseArgs(call.arguments);
    const tool = this.deps.registry.get(call.name);
    if (options.toolFilter && !options.toolFilter.has(call.name)) {
      this.deps.conversations.append(conversationId, {
        role: 'tool',
        content: `Tool "${call.name}" is not available in this context.`,
        toolCallId: call.id,
        name: call.name,
      });
      return {};
    }
    if (!tool) {
      const available = this.deps.registry
        .list()
        .slice(0, 40)
        .map((entry) => entry.definition.name)
        .join(', ');
      this.deps.conversations.append(conversationId, {
        role: 'tool',
        content: `Unknown tool "${call.name}". Available tools: ${available}`,
        toolCallId: call.id,
        name: call.name,
      });
      return {};
    }

    const signature = `${call.name}:${shortHash(JSON.stringify(args))}`;
    const count = (repeated.get(signature) ?? 0) + 1;
    repeated.set(signature, count);
    if (count > 2) {
      const message = `You already called ${call.name} with identical arguments ${count - 1} times. Do not repeat it. Use the previous result or try a different approach.`;
      this.deps.conversations.append(conversationId, {role: 'tool', content: message, toolCallId: call.id, name: call.name});
      return {};
    }

    events.push({type: 'tool_start', name: call.name, args, risk: tool.definition.risk});
    const started = Date.now();
    const result = await this.deps.registry.execute(call.name, args, context);
    const durationMs = result.durationMs || Date.now() - started;
    events.push({type: 'tool_end', name: call.name, ok: result.ok, summary: result.summary, durationMs, content: result.content});
    this.deps.conversations.append(conversationId, {
      role: 'tool',
      content: result.content || '(no output)',
      toolCallId: call.id,
      name: call.name,
      metadata: {ok: result.ok, denied: result.denied ?? false, durationMs},
    });
    return {};
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function canRunInParallel(risk: string, name: string, args: Record<string, unknown>, context: ToolContext): boolean {
  if (!['read', 'internal', 'external'].includes(risk)) return false;
  const toolDecision = context.policy.checkTool({name, risk: risk as never});
  if (toolDecision.action !== 'allow') return false;
  const argDecision = context.policy.checkToolArgs({name, risk: risk as never}, args);
  return argDecision.action === 'allow';
}

function integrationSummary(context: AgentDeps): string {
  const configured = context.integrations
    .status()
    .filter((entry) => entry.configured)
    .map((entry) => entry.label);
  if (!configured.length) return 'No external integrations are connected yet. You still have memory, tasks, files, shell and web tools.';
  return `Connected integrations: ${configured.join(', ')}.`;
}

