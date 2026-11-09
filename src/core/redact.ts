/** Redaction of credentials from logs, audit records and tool output. */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED ANTHROPIC KEY]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED TELEGRAM TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, 'Bearer [REDACTED]'],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization)\s*[:=]\s*["']?)([^\s"',;}]{6,})/gi,
    '$1[REDACTED]',
  ],
];

export function redact(value: string): string {
  let output = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'password',
  'secret',
  'authorization',
  'cookie',
  'masterkey',
  'master_key',
  'bot_token',
  'service_role_key',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-\s]/g, '_').replace(/_/g, ''));
}

/** Recursively redact an object for safe logging. Depth/size guarded. */
export function redactDeep<T>(input: T, depth = 0): T {
  if (depth > 6) return '[TRUNCATED]' as unknown as T;
  if (typeof input === 'string') return redact(input) as unknown as T;
  if (Array.isArray(input)) return input.slice(0, 100).map((item) => redactDeep(item, depth + 1)) as unknown as T;
  if (input && typeof input === 'object' && !(input instanceof Uint8Array)) {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? '[REDACTED]' : redactDeep(value, depth + 1);
    }
    return output as T;
  }
  return input;
}

/** Shorten long text for prompts/logs while keeping head and tail. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars || maxChars < 40) return text;
  const half = Math.floor((maxChars - 20) / 2);
  return `${text.slice(0, half)}\n…[truncated]…\n${text.slice(-half)}`;
}
