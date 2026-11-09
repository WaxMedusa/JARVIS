import {JarvisError} from '../core/errors.js';
import {BaseLLMProvider} from './retry.js';
import type {LLMRequest, LLMStreamEvent, ToolCall} from './types.js';

export interface MockTurn {
  text?: string;
  toolCalls?: ToolCall[];
  delayMs?: number;
  error?: string;
}

/** Deterministic provider used by tests, the smoke demo and offline development. */
export class MockProvider extends BaseLLMProvider {
  readonly id = 'mock';
  readonly model: string;
  readonly contextWindow = 32_000;
  private readonly turns: MockTurn[];
  private index = 0;
  readonly requests: LLMRequest[] = [];

  constructor(turns: MockTurn[] = [], model = 'mock-1') {
    super();
    this.turns = turns.length ? turns : [{text: 'All systems operational. Awaiting instructions.'}];
    this.model = model;
  }

  push(turn: MockTurn): void {
    this.turns.push(turn);
  }

  protected async *streamOnce(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void, void> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]!;
    this.index += 1;
    if (turn.delayMs) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    if (turn.error) throw new JarvisError('LLM_ERROR', turn.error);
    if (turn.text) {
      for (const chunk of chunkText(turn.text, 24)) {
        yield {type: 'text', text: chunk};
      }
    }
    for (const call of turn.toolCalls ?? []) {
      yield {type: 'tool_call', call};
    }
    yield {type: 'usage', usage: {inputTokens: 100, outputTokens: 50}};
    yield {type: 'done', finishReason: turn.toolCalls?.length ? 'tool_calls' : 'stop'};
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}
