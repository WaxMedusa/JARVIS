'use strict';

/**
 * Minimal Server-Sent Events parser. Feed it arbitrary transport chunks; it
 * emits one object per complete event, handling CRLF, comments and multi-line
 * data. Kept dependency-free so it can be unit-tested on any platform.
 */
class SSEParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += String(chunk ?? '');
    let boundary = this.findBoundary();
    while (boundary) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.emit(block);
      boundary = this.findBoundary();
    }
  }

  end() {
    if (this.buffer.trim()) this.emit(this.buffer);
    this.buffer = '';
  }

  findBoundary() {
    const match = /\r?\n\r?\n/.exec(this.buffer);
    if (!match || match.index === undefined) return null;
    return {index: match.index, length: match[0].length};
  }

  emit(block) {
    const parsed = parseSSEBlock(block);
    if (parsed) this.onEvent(parsed);
  }
}

function parseSSEBlock(block) {
  let event = 'message';
  const data = [];
  let sawField = false;
  for (const rawLine of String(block ?? '').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'event') event = value || 'message';
    else if (field === 'data') data.push(value);
  }
  if (!sawField && !data.length) return null;
  if (!data.length && event === 'message') return null;
  return {event, data: data.join('\n')};
}

module.exports = {SSEParser, parseSSEBlock};
