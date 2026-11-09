/** Shared LLM types. Providers normalize their APIs into this surface. */

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model (validated by the tool registry). */
  arguments: string;
}

export interface LLMMessage {
  role: LLMRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools: ToolDescriptor[];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Hint for providers that support structured output. */
  jsonMode?: boolean;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LLMStreamEvent =
  | {type: 'text'; text: string}
  | {type: 'reasoning'; text: string}
  | {type: 'tool_call'; call: ToolCall}
  | {type: 'usage'; usage: LLMUsage}
  | {type: 'done'; finishReason: string};

export interface LLMCompletion {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: LLMUsage;
  finishReason: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly contextWindow: number;
  stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void, void>;
  complete(request: LLMRequest): Promise<LLMCompletion>;
}
