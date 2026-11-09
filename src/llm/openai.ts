import OpenAI from 'openai';
import {JarvisError} from '../core/errors.js';
import {BaseLLMProvider, withRetry} from './retry.js';
import type {LLMMessage, LLMRequest, LLMStreamEvent, LLMUsage, ToolCall, ToolDescriptor} from './types.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  temperature: number;
  maxOutputTokens: number;
  retries: number;
  requestTimeoutMs: number;
  reasoningEffort?: string;
  providerLabel?: string;
}

/** Works with OpenAI and any OpenAI-compatible endpoint (Z.ai, OpenRouter, Ollama, LM Studio, LiteLLM). */
export class OpenAICompatProvider extends BaseLLMProvider {
  readonly id: string;
  readonly model: string;
  readonly contextWindow: number;
  private readonly client: OpenAI;
  private readonly options: OpenAIProviderOptions;
  private maxTokensParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
  private streamUsage = true;

  constructor(options: OpenAIProviderOptions) {
    super();
    if (!options.apiKey) {
      throw new JarvisError(
        'CONFIG',
        `Missing API key for ${options.providerLabel ?? 'OpenAI-compatible'} provider. Set OPENAI_API_KEY or LLM_API_KEY.`,
      );
    }
    this.options = options;
    this.id = options.providerLabel ?? 'openai';
    this.model = options.model;
    this.contextWindow = options.contextWindow;
    this.retries = options.retries;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.requestTimeoutMs,
      maxRetries: 0,
    });
  }

  protected async *streamOnce(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void, void> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(request.messages),
      tools: request.tools.map(toOpenAITool),
      temperature: request.temperature ?? this.options.temperature,
      stream: true,
      ...(this.streamUsage ? {stream_options: {include_usage: true}} : {}),
      ...(this.options.reasoningEffort ? {reasoning_effort: this.options.reasoningEffort} : {}),
      ...(request.jsonMode ? {response_format: {type: 'json_object'}} : {}),
    };
    body[this.maxTokensParam] = request.maxOutputTokens ?? this.options.maxOutputTokens;
    if (request.tools.length === 0) delete body.tools;

    const stream = await this.createStream(body, request.abortSignal);

    let finishReason = 'stop';
    let usage: LLMUsage = {inputTokens: 0, outputTokens: 0};
    const calls = new Map<number, {id: string; name: string; args: string}>();

    for await (const raw of stream as AsyncIterable<any>) {
      const choice = raw?.choices?.[0];
      if (raw?.usage) {
        usage = {
          inputTokens: Number(raw.usage.prompt_tokens ?? 0),
          outputTokens: Number(raw.usage.completion_tokens ?? 0),
        };
      }
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const text = typeof delta.content === 'string' ? delta.content : '';
      if (text) yield {type: 'text', text};
      const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
      if (typeof reasoning === 'string' && reasoning) yield {type: 'reasoning', text: reasoning};

      for (const part of delta.tool_calls ?? []) {
        const index = Number(part.index ?? 0);
        const slot = calls.get(index) ?? {id: '', name: '', args: ''};
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name += part.function.name;
        if (part.function?.arguments) slot.args += part.function.arguments;
        calls.set(index, slot);
      }
      if (choice.finish_reason) finishReason = String(choice.finish_reason);
    }

    for (const [index, slot] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name) continue;
      const call: ToolCall = {
        id: slot.id || `call_${Date.now()}_${index}`,
        name: slot.name,
        arguments: slot.args.trim() || '{}',
      };
      yield {type: 'tool_call', call};
    }
    yield {type: 'usage', usage};
    yield {type: 'done', finishReason};
  }

  private async createStream(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return withRetry(
      async () => {
        try {
          return await this.client.chat.completions.create(body as never, {signal});
        } catch (error) {
          const err = error as {status?: number; message?: string; error?: {message?: string}};
          const message = `${err?.message ?? ''} ${err?.error?.message ?? ''}`.toLowerCase();
          if (err?.status === 400 && message.includes('stream_options') && this.streamUsage) {
            this.streamUsage = false;
            delete body.stream_options;
            return await this.client.chat.completions.create(body as never, {signal});
          }
          if (err?.status === 400 && message.includes('max_completion_tokens')) {
            this.maxTokensParam = 'max_completion_tokens';
            this.renumberMaxTokens(body);
            return await this.client.chat.completions.create(body as never, {signal});
          }
          if (err?.status === 400 && message.includes('max_tokens')) {
            this.maxTokensParam = 'max_tokens';
            this.renumberMaxTokens(body);
            return await this.client.chat.completions.create(body as never, {signal});
          }
          if (err?.status === 400 && message.includes('temperature') && 'temperature' in body) {
            delete body.temperature;
            return await this.client.chat.completions.create(body as never, {signal});
          }
          throw error;
        }
      },
      {retries: this.retries, signal},
    );
  }

  private renumberMaxTokens(body: Record<string, unknown>): void {
    const value = body.max_tokens ?? body.max_completion_tokens;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    body[this.maxTokensParam] = value;
  }
}

export function toOpenAIMessages(messages: LLMMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? 'unknown', ...(message.name ? {name: message.name} : {})};
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {name: call.name, arguments: call.arguments},
        })),
      };
    }
    return {role: message.role, content: message.content};
  });
}

export function toOpenAITool(tool: ToolDescriptor): unknown {
  return {
    type: 'function',
    function: {name: tool.name, description: tool.description, parameters: tool.parameters},
  };
}
