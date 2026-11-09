'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DEFAULT_SETTINGS, validateBaseUrl, normalizeInput, normalizeHotkey} = require('../src/main/settings');

test('accepts loopback and reverse-proxy origins', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.equal(validateBaseUrl('https://jarvis.example.com/assistant/'), 'https://jarvis.example.com/assistant');
});

test('rejects credentials, file URLs and malformed input', () => {
  assert.throws(() => validateBaseUrl('file:///etc/passwd'), /http/);
  assert.throws(() => validateBaseUrl('http://user:pass@example.com'), /credentials/i);
  assert.throws(() => validateBaseUrl('not a url'), /valid URL/i);
  assert.throws(() => validateBaseUrl(''), /required/i);
});

test('normalizes booleans and falls back for a bad hotkey', () => {
  const normalized = normalizeInput({baseUrl: 'http://localhost:9000', alwaysOnTop: 1, launchAtLogin: 0});
  assert.equal(normalized.baseUrl, 'http://localhost:9000');
  assert.equal(normalized.alwaysOnTop, true);
  assert.equal(normalized.launchAtLogin, false);
  assert.equal(normalized.hotkey, DEFAULT_SETTINGS.hotkey);
  assert.equal(normalizeHotkey('CommandOrControl+Shift+J'), 'CommandOrControl+Shift+J');
});
