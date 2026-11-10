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
    const {timeoutMs = this.timeoutMs, ...fetchOptions} = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...fetchOptions,
        headers: this.headers(fetchOptions.headers || {}),
        signal: fetchOptions.signal || controller.signal,
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

  async notes(options = {}) {
    const params = new URLSearchParams();
    if (options.query) params.set('query', String(options.query));
    if (options.tag) params.set('tag', String(options.tag));
    if (options.archived) params.set('archived', 'true');
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    const suffix = params.toString() ? `?${params}` : '';
    return this.request(`/v1/notes${suffix}`);
  }

  async note(id) {
    const result = await this.request(`/v1/notes/${encodeURIComponent(id)}`);
    return result.note;
  }

  async createNote(note = {}) {
    const result = await this.request('/v1/notes', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        title: note.title,
        content: note.content,
        tags: note.tags,
        pinned: Boolean(note.pinned),
        source: note.source || 'companion',
      }),
    });
    return result.note;
  }

  async updateNote(id, patch = {}) {
    const result = await this.request(`/v1/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(patch),
    });
    return result.note;
  }

  async deleteNote(id) {
    return this.request(`/v1/notes/${encodeURIComponent(id)}`, {method: 'DELETE'});
  }

  async calendar(days = 7) {
    return this.request(`/v1/calendar?days=${encodeURIComponent(days)}`, {timeoutMs: 45_000});
  }

  async createCalendarEvent(event = {}) {
    const result = await this.request('/v1/calendar/events', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(event),
      timeoutMs: 45_000,
    });
    return result.event;
  }

  async calendarFeeds() {
    const result = await this.request('/v1/calendar/feeds');
    return Array.isArray(result.feeds) ? result.feeds : [];
  }

  async addCalendarFeed(feed = {}) {
    const result = await this.request('/v1/calendar/feeds', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({url: feed.url, label: feed.label}),
      timeoutMs: 45_000,
    });
    return result.feed;
  }

  async removeCalendarFeed(id) {
    return this.request(`/v1/calendar/feeds/${encodeURIComponent(id)}`, {method: 'DELETE'});
  }

  async canvas() {
    return this.request('/v1/canvas', {timeoutMs: 60_000});
  }

  async canvasAssignments(courseId, bucket = 'upcoming') {
    const params = new URLSearchParams({course_id: String(courseId), bucket: String(bucket)});
    const result = await this.request(`/v1/canvas/assignments?${params}`, {timeoutMs: 45_000});
    return Array.isArray(result.assignments) ? result.assignments : [];
  }

  async transcribeAudio({data, mime = 'audio/webm', filename = 'voice-note.webm'} = {}) {
    const form = new FormData();
    form.append('file', audioBlob(data, mime), filename);
    const result = await this.request('/v1/audio/transcribe', {
      method: 'POST',
      body: form,
      timeoutMs: 180_000,
    });
    return String(result.transcript || result.text || '');
  }

  async createAudioNote({data, mime = 'audio/webm', filename = 'voice-note.webm', title, tags, durationSeconds, summarize = true} = {}) {
    const form = new FormData();
    form.append('file', audioBlob(data, mime), filename);
    if (title) form.append('title', String(title));
    if (tags) form.append('tags', Array.isArray(tags) ? JSON.stringify(tags) : String(tags));
    if (Number.isFinite(Number(durationSeconds))) form.append('duration_seconds', String(durationSeconds));
    form.append('summarize', summarize ? 'true' : 'false');
    const result = await this.request('/v1/notes/audio', {
      method: 'POST',
      body: form,
      timeoutMs: 240_000,
    });
    return result;
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

function audioBlob(data, mime) {
  if (data instanceof ArrayBuffer) return new Blob([new Uint8Array(data)], {type: mime});
  if (ArrayBuffer.isView(data)) return new Blob([new Uint8Array(data.buffer, data.byteOffset, data.byteLength)], {type: mime});
  if (typeof data === 'string') return new Blob([Buffer.from(data, 'base64')], {type: mime});
  throw new Error('Audio data is required.');
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
