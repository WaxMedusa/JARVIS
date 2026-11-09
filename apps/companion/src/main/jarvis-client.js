'use strict';

const {SSEParser} = require('./sse');

/** HTTP/SSE client for the local JARVIS daemon. Runs only in the main process. */
class JarvisClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    this.token = String(options.token || '');
    this.timeoutMs = Number(options.timeoutMs || 15000);
  }

  headers(extra = {}) {
    const headers = {accept: 'application/json', ...extra};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: this.headers(options.headers || {}),
        signal: options.signal || controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(extractError(text, response.status));
      if (!text.trim()) return {};
      return JSON.parse(text);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('JARVIS did not respond. Is `jarvis serve` running?');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return this.request('/v1/status');
  }

  async remember(content, options = {}) {
    const body = {
      content: String(content || '').slice(0, 8000),
      kind: options.kind || 'note',
      importance: Number.isFinite(options.importance) ? options.importance : 0.55,
      source: options.source || 'companion',
    };
    const result = await this.request('/v1/memory', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    return result.memory;
  }

  async conversations(limit = 20) {
    const result = await this.request(`/v1/conversations?limit=${encodeURIComponent(limit)}`);
    return Array.isArray(result.conversations) ? result.conversations : [];
  }

  async messages(conversationId, limit = 200) {
    const result = await this.request(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=${encodeURIComponent(limit)}`,
    );
    return Array.isArray(result.messages) ? result.messages : [];
  }

  async approve(id, approved) {
    return this.request(`/v1/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({approved: Boolean(approved)}),
    });
  }

  /**
   * Stream one chat turn. onEvent receives flattened SSE payloads such as
   * {type:'text', text:'...'} and {type:'done', ...}. Resolves when the stream
   * closes; the caller owns cancellation through the AbortSignal.
   */
  async chat({message, conversationId, onEvent, signal}) {
    const response = await fetch(`${this.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        accept: 'text/event-stream',
      }),
      body: JSON.stringify({
        message,
        conversationId: conversationId || undefined,
        channel: 'companion',
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(extractError(text, response.status));
    }
    if (!response.body) throw new Error('The daemon returned an empty stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser(({event, data}) => {
      let payload;
      try {
        payload = data ? JSON.parse(data) : {};
      } catch {
        payload = {text: data};
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {value: payload};
      onEvent({type: event, ...payload});
    });

    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, {stream: true}));
      }
      parser.push(decoder.decode());
      parser.end();
    } finally {
      reader.releaseLock();
    }
  }
}

function extractError(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
    if (parsed && typeof parsed.message === 'string') return parsed.message;
  } catch {
    // fall through
  }
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 400) : `JARVIS returned HTTP ${status}.`;
}

module.exports = {JarvisClient, extractError};
