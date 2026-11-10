'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {buildBackendEnv, resolveBackendEntry, redact} = require('../src/main/backend');

const baseSettings = {
  provider: 'openai',
  model: 'gpt-5.1',
  apiBaseUrl: '',
  canvasBaseUrl: 'https://school.instructure.com',
};

test('builds a private core environment without leaking keys into config', () => {
  const env = buildBackendEnv({
    settings: baseSettings,
    apiKey: 'sk-test-secret',
    canvasToken: 'canvas-secret',
    home: '/tmp/jarvis-home',
    port: 4321,
    token: 'session-token',
    baseEnv: {PATH: '/usr/bin'},
  });
  assert.equal(env.JARVIS_SERVER_HOST, '127.0.0.1');
  assert.equal(env.JARVIS_SERVER_PORT, '4321');
  assert.equal(env.JARVIS_API_TOKEN, 'session-token');
  assert.equal(env.JARVIS_LLM_PROVIDER, 'openai');
  assert.equal(env.OPENAI_API_KEY, 'sk-test-secret');
  assert.equal(env.CANVAS_API_TOKEN, 'canvas-secret');
  assert.equal(env.CANVAS_BASE_URL, 'https://school.instructure.com');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('maps OpenRouter and Gemini onto the OpenAI-compatible core', () => {
  const openrouter = buildBackendEnv({
    settings: {...baseSettings, provider: 'openrouter'},
    apiKey: 'or-key',
    home: '/tmp/home',
    port: 1,
    token: 't',
    baseEnv: {},
  });
  assert.equal(openrouter.JARVIS_LLM_PROVIDER, 'custom');
  assert.equal(openrouter.LLM_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.equal(openrouter.LLM_API_KEY, 'or-key');
  assert.equal(openrouter.OPENAI_API_KEY, undefined);

  const google = buildBackendEnv({
    settings: {...baseSettings, provider: 'google'},
    apiKey: 'google-key',
    home: '/tmp/home',
    port: 1,
    token: 't',
    baseEnv: {},
  });
  assert.equal(google.JARVIS_LLM_PROVIDER, 'custom');
  assert.equal(google.LLM_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(google.LLM_API_KEY, 'google-key');
});

test('uses the bundled core in packaged builds and never in asar', () => {
  assert.equal(
    resolveBackendEntry({isPackaged: true, resourcesPath: '/Applications/JARVIS.app/Contents/Resources', appRoot: '/repo'}),
    path.join('/Applications/JARVIS.app/Contents/Resources', 'backend', 'index.cjs'),
  );
  assert.equal(
    resolveBackendEntry({isPackaged: false, resourcesPath: '/ignored', appRoot: '/repo'}),
    path.join('/repo', 'dist', 'cli', 'index.js'),
  );
});

test('redacts keys from captured core logs', () => {
  const line = redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz Authorization: Bearer abcdefghijklmnop');
  assert.doesNotMatch(line, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(line, /Bearer abcdefghijklmnop/);
});
