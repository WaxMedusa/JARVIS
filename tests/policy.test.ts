import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createHarness, type Harness} from './helpers.js';
import {Policy} from '../src/security/policy.js';
import type {JarvisConfig} from '../src/config.js';

let harness: Harness | undefined;

afterEach(() => {
  harness?.shutdown();
  harness = undefined;
});

describe('Policy', () => {
  it('allows paths inside the jail and rejects escapes', () => {
    harness = createHarness();
    const inside = path.join(harness.home, 'notes.md');
    fs.writeFileSync(inside, 'hello');
    expect(harness.policy.validatePath(inside).action).toBe('allow');
    expect(harness.policy.validatePath('/etc/passwd').action).toBe('deny');
    expect(harness.policy.validatePath(path.join(harness.home, '..', 'escape.md')).action).toBe('deny');
  });

  it('canonicalizes an allowed root that is itself a symlink', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-real-root-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link, 'dir');
    try {
      const policy = new Policy({security: {allowedPaths: [link], denyPathPatterns: []}} as unknown as JarvisConfig);
      const inside = path.join(real, 'note.md');
      fs.writeFileSync(inside, 'hello');
      expect(policy.validatePath(inside).action).toBe('allow');
      expect(policy.validatePath(path.join(real, '..', 'escape.md')).action).toBe('deny');
    } finally {
      fs.rmSync(link, {force: true});
      fs.rmSync(real, {recursive: true, force: true});
    }
  });

  it('blocks symlink escapes', () => {
    harness = createHarness();
    const outside = path.join(os.tmpdir(), `jarvis-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret');
    const link = path.join(harness.home, 'link.txt');
    try {
      fs.symlinkSync(outside, link);
      expect(harness.policy.validatePath(link).action).toBe('deny');
    } finally {
      fs.rmSync(outside, {force: true});
    }
  });

  it('protects sensitive paths', () => {
    harness = createHarness();
    const env = path.join(harness.home, '.ssh', 'id_rsa');
    fs.mkdirSync(path.dirname(env), {recursive: true});
    fs.writeFileSync(env, 'key');
    expect(harness.policy.validatePath(env).action).toBe('deny');
  });

  it('gates shell commands by allowlist and danger patterns', () => {
    harness = createHarness();
    expect(harness.policy.checkShell('ls -la').action).toBe('allow');
    expect(harness.policy.checkShell('curl https://example.com').action).toBe('ask');
    expect(harness.policy.checkShell('rm -rf /').action).toBe('deny');
    expect(harness.policy.checkShell('ls; cat /etc/passwd').action).toBe('deny');
    expect(harness.policy.checkShell('ls && whoami').action).toBe('ask');
  });

  it('blocks private network URLs unless explicitly allowed', () => {
    harness = createHarness();
    expect(harness.policy.checkUrl('https://example.com/page').action).toBe('allow');
    expect(harness.policy.checkUrl('http://127.0.0.1:8080').action).toBe('deny');
    expect(harness.policy.checkUrl('http://169.254.169.254/latest/meta-data').action).toBe('deny');
    expect(harness.policy.checkUrl('file:///etc/passwd').action).toBe('deny');
  });

  it('applies risk-based approval rules', () => {
    harness = createHarness();
    expect(harness.policy.checkTool({name: 'recall', risk: 'read'}).action).toBe('allow');
    expect(harness.policy.checkTool({name: 'remember', risk: 'internal'}).action).toBe('allow');
    expect(harness.policy.checkTool({name: 'run_shell', risk: 'execute'}).action).toBe('allow'); // autonomous harness
    expect(harness.policy.checkTool({name: 'gmail_send', risk: 'irreversible'}).action).toBe('ask');
  });
});
