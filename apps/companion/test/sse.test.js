'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {SSEParser, parseSSEBlock} = require('../src/main/sse');

test('parses a complete event block', () => {
  const event = parseSSEBlock('event: text\ndata: {"text":"hello"}');
  assert.deepEqual(event, {event: 'text', data: '{"text":"hello"}'});
});

test('joins multi-line data and ignores comments', () => {
  const parsed = [];
  const parser = new SSEParser((event) => parsed.push(event));
  parser.push(': heartbeat\n\nevent: note\ndata: first\ndata: second\n\n');
  assert.deepEqual(parsed, [{event: 'note', data: 'first\nsecond'}]);
});

test('handles arbitrary transport fragmentation', () => {
  const parsed = [];
  const parser = new SSEParser((event) => parsed.push(event));
  for (const piece of ['event: te', 'xt\r\ndata: {"te', 'xt":"frac', 'tured"}\r\n\r', '\n']) parser.push(piece);
  parser.end();
  assert.deepEqual(parsed, [{event: 'text', data: '{"text":"fractured"}'}]);
});

test('flushes a trailing block without a blank line', () => {
  const parsed = [];
  const parser = new SSEParser((event) => parsed.push(event));
  parser.push('event: done\ndata: {}');
  parser.end();
  assert.deepEqual(parsed, [{event: 'done', data: '{}'}]);
});

test('drops empty comment-only blocks', () => {
  assert.equal(parseSSEBlock(': ping'), null);
  assert.equal(parseSSEBlock(''), null);
});
