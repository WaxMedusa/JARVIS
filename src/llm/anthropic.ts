import {JarvisError, httpError} from '../core/errors.js';
import {BaseLLMProvider, withRetry} from './retry.js';
import type {LLMMessage, LLMRequest, LLMStreamEvent, LLMUsage, ToolCall} from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  temperature: number;
  maxOutputTokens: number;
  retries: number;
  requestTimeoutMs: number;
}

/** Native Anthropic Messages API client with streaming, tools and prompt caching. */
export class AnthropicProvider extends BaseLLMProvider {
  readonly id = 'anthropic';
  readonly model: string;
  readonly contextWindow: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly options: AnthropicProviderOptions;

  constructor(options: AnthropicProviderOptions) {
    super();
    if (!options.apiKey) throw new JarvisError('CONFIG', 'Missing ANTHROPIC_API_KEY.');
    this.options = options;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.contextWindow = options.contextWindow;
    this.retries = options.retries;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  protected async *streamOnce(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void, void> {
    const {system, messages} = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? this.options.maxOutputTokens,
      temperature: request.temperature ?? this.options.temperature,
      system: system ? [{type: 'text', text: system, cache_control: {type: 'ephemeral'}}] : undefined,
      messages,
      tools: request.tools.length
        ? request.tools.map((tool, index) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
            ...(index === request.tools.length - 1 ? {cache_control: {type: 'ephemeral'}} : {}),
          }))
        : undefined,
      stream: true,
    };

    const response = await withRetry(
      () =>
        fetch(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: request.abortSignal,
        }),
      {retries: this.retries, signal: request.abortSignal},
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryAfter = Number(response.headers.get('retry-after') ?? '') || undefined;
      throw httpError('Anthropic', response.status, text, retryAfter);
    }
    if (!response.body) throw new JarvisError('LLM_ERROR', 'Anthropic returned an empty response body');

    let usage: LLMUsage = {inputTokens: 0, outputTokens: 0};
    let finishReason = 'end_turn';
    const toolBlocks = new Map<number, {id: string; name: string; json: string}>();

    for await (const event of parseSSE(response.body)) {
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }
      switch (event.event || data.type) {
        case 'message_start': {
          usage.inputTokens = Number(data.message?.usage?.input_tokens ?? 0);
          usage.outputTokens = Number(data.message?.usage?.output_tokens ?? 0);
          break;
        }
        case 'content_block_start': {
          const block = data.content_block;
          if (block?.type === 'tool_use') {
            toolBlocks.set(Number(data.index), {id: String(block.id), name: String(block.name), json: ''});
          } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
            yield {type: 'text', text: block.text};
          }
          break;
        }
        case 'content_block_delta': {
          const delta = data.delta ?? {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string') yield {type: 'text', text: delta.text};
          else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') yield {type: 'reasoning', text: delta.thinking};
          else if (delta.type === 'input_json_delta') {
            const slot = toolBlocks.get(Number(data.index));
            if (slot && typeof delta.partial_json === 'string') slot.json += delta.partial_json;
          }
          break;
        }
        case 'message_delta': {
          if (data.delta?.stop_reason) finishReason = String(data.delta.stop_reason);
          if (data.usage?.output_tokens !== undefined) usage.outputTokens = Number(data.usage.output_tokens);
          break;
        }
        case 'error': {
          throw new JarvisError('LLM_ERROR', `Anthropic stream error: ${data.error?.message ?? 'unknown'}`);
        }
        default:
          break;
      }
    }

    for (const [index, slot] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = {id: slot.id || `toolu_${index}`, name: slot.name, arguments: slot.json.trim() || '{}'};
      yield {type: 'tool_call', call};
    }
    yield {type: 'usage', usage};
    yield {type: 'done', finishReason};
  }
}

export function toAnthropicMessages(messages: LLMMessage[]): {system: string; messages: unknown[]} {
  const systemParts: string[] = [];
  const converted: Array<{role: 'user' | 'assistant'; content: any[]}> = [];

  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return;
    const last = converted[converted.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else converted.push({role, content: blocks});
  };

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? 'unknown',
          content: message.content,
        },
      ]);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: any[] = [];
      if (message.content.trim()) blocks.push({type: 'text', text: message.content});
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({type: 'tool_use', id: call.id, name: call.name, input});
      }
      push('assistant', blocks);
      continue;
    }
    push('user', [{type: 'text', text: message.content || '(empty)'}]);
  }

  if (!converted.length) converted.push({role: 'user', content: [{type: 'text', text: '(continue)'}]});
  return {system: systemParts.join('\n\n'), messages: converted};
}

export interface SSEEvent {
  event: string;
  data: string;
}

/** Minimal, buffered SSE parser for fetch response bodies. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let dataLines: string[] = [];

  const flush = (): SSEEvent | null => {
    if (!dataLines.length) {
      event = '';
      return null;
    }
    const result = {event, data: dataLines.join('\n')};
    event = '';
    dataLines = [];
    return result;
  };

  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const ready = flush();
          if (ready) yield ready;
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
