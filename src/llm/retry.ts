import {isAbortError, JarvisError} from '../core/errors.js';
import type {LLMCompletion, LLMProvider, LLMRequest, LLMStreamEvent, LLMUsage} from './types.js';

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new JarvisError('TIMEOUT', 'Operation aborted', {cause: new DOMException('Aborted', 'AbortError')}));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, {once: true});
  });
}

export function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof JarvisError) return error.retryable;
  if (!error || typeof error !== 'object') return false;
  const err = error as {status?: number; code?: string; message?: string};
  if (err.status && (err.status === 408 || err.status === 429 || err.status >= 500)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(err.code ?? '')) {
    return true;
  }
  const message = (err.message ?? '').toLowerCase();
  return /rate limit|overloaded|temporarily unavailable|timeout|socket hang up/.test(message);
}

export function backoffMs(attempt: number, base = 700, cap = 15_000): number {
  const exponential = Math.min(cap, base * 2 ** attempt);
  return Math.round(exponential * (0.6 + Math.random() * 0.8));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {retries?: number; signal?: AbortSignal; onRetry?: (error: unknown, attempt: number, delay: number) => void} = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryable(error) || options.signal?.aborted) throw error;
      const delay = backoffMs(attempt);
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

/**
 * Common provider plumbing: retry only when nothing has been emitted yet,
 * so a resumed stream never duplicates partial output.
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly id: string;
  abstract readonly model: string;
  abstract readonly contextWindow: number;
  protected retries = 2;
  protected requestTimeoutMs = 120_000;

  protected abstract streamOnce(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void, void>;

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent, void, void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.abortSignal?.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let emitted = false;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const inner = this.streamOnce({...request, abortSignal: controller.signal});
          for await (const event of inner) {
            emitted = true;
            yield event;
          }
          return;
        } catch (error) {
          if (request.abortSignal?.aborted) {
            throw new JarvisError('TIMEOUT', 'LLM request aborted by caller', {cause: error});
          }
          if (emitted || attempt >= this.retries || !isRetryable(error)) throw normalizeLLMError(error);
          await sleep(backoffMs(attempt), controller.signal);
        }
      }
    } finally {
      clearTimeout(timer);
      request.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  async complete(request: LLMRequest): Promise<LLMCompletion> {
    let text = '';
    let reasoning = '';
    const toolCalls = [];
    let usage: LLMUsage = {inputTokens: 0, outputTokens: 0};
    let finishReason = 'stop';
    for await (const event of this.stream(request)) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'reasoning') reasoning += event.text;
      else if (event.type === 'tool_call') toolCalls.push(event.call);
      else if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'done') finishReason = event.finishReason;
    }
    return {text, reasoning, toolCalls, usage, finishReason};
  }
}

export function normalizeLLMError(error: unknown): JarvisError {
  if (error instanceof JarvisError) return error;
  if (isAbortError(error)) return new JarvisError('TIMEOUT', 'LLM request timed out', {cause: error});
  const err = error as {status?: number; message?: string; error?: {message?: string}};
  if (err?.status) {
    return new JarvisError('LLM_ERROR', `LLM provider error (HTTP ${err.status}): ${err.error?.message ?? err.message ?? 'unknown'}`, {
      status: 502,
      retryable: err.status === 429 || err.status >= 500,
      cause: error,
    });
  }
  return new JarvisError('LLM_ERROR', `LLM request failed: ${(error as Error)?.message ?? String(error)}`, {cause: error});
}
