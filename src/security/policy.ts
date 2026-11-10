import fs from 'node:fs';
import path from 'node:path';
import type {JarvisConfig, RiskLevel} from '../config.js';
import {expandHome} from '../config.js';
import {JarvisError} from '../core/errors.js';

export type PolicyAction = 'allow' | 'ask' | 'deny';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
}

export interface ToolLike {
  name: string;
  risk: RiskLevel;
}

const DANGEROUS_SHELL = [
  /\brm\s+(-[a-zA-Z]*\s+)*-(r|f|rf|fr)\s+\/(?:\s|$)/i,
  /\bmkfs(\.| )/i,
  /\bdd\s+.*of=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\s*\(\s*\)\s*\{/,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/i,
  /\bwget\b[^|]*\|\s*(ba|z)?sh\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
  />\s*\/dev\/sd[a-z]/i,
  /\bhistory\s+-c\b/i,
  /\bpasswd\b/i,
];

const SHELL_CHAINING = /[;&|`$()<>]|\bthen\b|\bdo\b/;

/**
 * Central permission engine. Every tool invocation passes through here.
 * Path, URL and shell guards are defense-in-depth on top of model instructions.
 */
export class Policy {
  private readonly config: JarvisConfig;
  private readonly roots: string[];
  private readonly denyPatterns: RegExp[];

  constructor(config: JarvisConfig) {
    this.config = config;
    this.roots = config.security.allowedPaths.map((root) => canonicalRoot(root));
    this.denyPatterns = config.security.denyPathPatterns.map(globToRegExp);
  }

  get allowedRoots(): string[] {
    return [...this.roots];
  }

  checkTool(tool: ToolLike): PolicyDecision {
    const security = this.config.security;
    if (security.toolDeny.includes(tool.name)) {
      return {action: 'deny', reason: `Tool "${tool.name}" is disabled in configuration.`};
    }
    if (security.toolAllow.length > 0 && !security.toolAllow.includes(tool.name)) {
      return {action: 'deny', reason: `Tool "${tool.name}" is not in the tool allowlist.`};
    }

    const irreversibleNeedsConsent = tool.risk === 'irreversible' && !security.allowIrreversible;
    if (irreversibleNeedsConsent) {
      return {
        action: 'ask',
        reason: 'This is an irreversible action (sending, deleting or spending). Explicit approval required.',
      };
    }
    if (security.alwaysApprove.includes(tool.name)) return {action: 'allow', reason: 'Tool is pre-approved.'};

    switch (tool.risk) {
      case 'read':
      case 'internal':
      case 'external':
        return {action: 'allow', reason: 'Read or locally reversible operation.'};
      case 'write':
      case 'execute':
        if (security.approvalMode === 'strict') return {action: 'ask', reason: 'Strict mode requires approval for writes and execution.'};
        if (security.approvalMode === 'autonomous') return {action: 'allow', reason: 'Autonomous mode.'};
        return {action: 'ask', reason: 'This changes state outside the assistant.'};
      case 'irreversible':
      default:
        return {action: 'ask', reason: 'Irreversible action.'};
    }
  }

  /** Validate tool arguments that carry paths, URLs or shell commands. */
  checkToolArgs(tool: ToolLike, args: Record<string, unknown>): PolicyDecision {
    if (typeof args.path === 'string') {
      const result = this.validatePath(args.path, {forWrite: tool.risk !== 'read'});
      if (result.action !== 'allow') return result;
    }
    for (const key of ['paths', 'files']) {
      const value = args[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item !== 'string') continue;
          const result = this.validatePath(item, {forWrite: tool.risk !== 'read'});
          if (result.action !== 'allow') return result;
        }
      }
    }
    if (typeof args.url === 'string') return this.checkUrl(args.url);
    if (typeof args.command === 'string') return this.checkShell(args.command);
    return {action: 'allow', reason: 'Arguments passed static checks.'};
  }

  validatePath(input: string, options: {forWrite?: boolean; mustExist?: boolean} = {}): PolicyDecision {
    let resolved: string;
    try {
      resolved = path.resolve(expandHome(input));
    } catch {
      return {action: 'deny', reason: 'Invalid path.'};
    }
    const normalized = resolved.split(path.sep).join('/');

    for (const pattern of this.denyPatterns) {
      if (pattern.test(normalized)) {
        return {action: 'deny', reason: `Path is explicitly protected by policy (${pattern.source}).`};
      }
    }

    // Resolve symlinks for existing paths so a link cannot escape the jail.
    let effective = resolved;
    try {
      if (fs.existsSync(resolved)) effective = fs.realpathSync(resolved);
      else {
        const parent = path.dirname(resolved);
        if (fs.existsSync(parent)) effective = path.join(fs.realpathSync(parent), path.basename(resolved));
      }
    } catch {
      return {action: 'deny', reason: 'Path could not be resolved safely.'};
    }

    if (!this.roots.some((root) => isWithin(effective, root))) {
      return {
        action: 'deny',
        reason: `Path is outside the allowed roots: ${this.roots.join(', ') || '(none configured)'}`,
      };
    }
    if (options.mustExist && !fs.existsSync(effective)) {
      return {action: 'deny', reason: `Path does not exist: ${input}`};
    }
    return {action: 'allow', reason: 'Path is inside the sandbox.'};
  }

  /** Throws when a path is not allowed; returns the canonical path otherwise. */
  assertPath(input: string, options: {forWrite?: boolean; mustExist?: boolean} = {}): string {
    const decision = this.validatePath(input, options);
    if (decision.action !== 'allow') throw new JarvisError('POLICY_DENIED', decision.reason);
    const resolved = path.resolve(expandHome(input));
    try {
      if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    } catch {
      // fall through to the normalized path
    }
    return resolved;
  }

  checkShell(command: string): PolicyDecision {
    const trimmed = command.trim();
    if (!trimmed) return {action: 'deny', reason: 'Empty command.'};
    for (const pattern of DANGEROUS_SHELL) {
      if (pattern.test(trimmed)) return {action: 'deny', reason: 'Command matches a destructive or unsafe pattern.'};
    }
    const allowlist = this.config.security.shellAllowlist;
    const matchesAllowed = allowlist.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
    if (!matchesAllowed) {
      return {action: 'ask', reason: 'Command is not on the shell allowlist; approval required.'};
    }
    if (SHELL_CHAINING.test(trimmed)) {
      return {action: 'ask', reason: 'Command contains shell chaining or redirection; approval required.'};
    }
    return {action: 'allow', reason: 'Command matches the allowlist.'};
  }

  checkUrl(raw: string): PolicyDecision {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {action: 'deny', reason: 'Invalid URL.'};
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {action: 'deny', reason: `Unsupported URL protocol: ${url.protocol}`};
    }
    if (url.username || url.password) return {action: 'deny', reason: 'URLs with embedded credentials are not allowed.'};

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (this.config.security.allowPrivateNetwork) return {action: 'allow', reason: 'Private network access is enabled.'};

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      return {action: 'deny', reason: 'Local network hosts are blocked by policy.'};
    }
    if (isPrivateAddress(host) || host === '169.254.169.254' || host === 'metadata.google.internal') {
      return {action: 'deny', reason: 'Private and metadata addresses are blocked by policy.'};
    }
    return {action: 'allow', reason: 'Public URL.'};
  }

  describe(): Record<string, unknown> {
    return {
      approvalMode: this.config.security.approvalMode,
      allowedRoots: this.roots,
      shellAllowlist: this.config.security.shellAllowlist,
      allowPrivateNetwork: this.config.security.allowPrivateNetwork,
      allowIrreversible: this.config.security.allowIrreversible,
      denyPathPatterns: this.config.security.denyPathPatterns,
    };
  }
}

/**
 * Canonicalize a configured allow-root. On macOS `/tmp` and `/var` are
 * symlinks, so comparing a realpath'd candidate against a non-canonical root
 * would reject files that are actually inside the jail.
 */
function canonicalRoot(value: string): string {
  const resolved = path.resolve(expandHome(value));
  try {
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    const parent = path.dirname(resolved);
    if (parent !== resolved && fs.existsSync(parent)) {
      return path.join(fs.realpathSync(parent), path.basename(resolved));
    }
  } catch {
    // Fall back to the resolved path; validatePath will still deny escapes.
  }
  return resolved;
}

export function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isPrivateAddress(host: string): boolean {
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host) || /^0\.0\.0\.0$/.test(host) || /^::1?$/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  return false;
}

export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}
