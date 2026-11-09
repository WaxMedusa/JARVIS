import {JarvisError, httpError} from './errors.js';
import {withRetry} from '../llm/retry.js';

export interface HttpOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  service?: string;
  maxBytes?: number;
}

export interface CappedText {
  text: string;
  truncated: boolean;
  contentType: string;
  finalUrl: string;
  status: number;
  headers: Headers;
}

/** fetch with timeout, retry (on network/5xx/429), redirect policy and size cap. */
export async function fetchCapped(url: string, options: HttpOptions = {}): Promise<CappedText> {
  const {timeoutMs = 30_000, retries = 2, service = 'HTTP', maxBytes = 2 * 1024 * 1024, ...init} = options;
  const response = await withRetry(
    () =>
      fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        redirect: init.redirect ?? 'follow',
      }),
    {retries, signal: init.signal ?? undefined},
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const retryAfter = Number(response.headers.get('retry-after') ?? '') || undefined;
    throw httpError(service, response.status, body, retryAfter);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const reader = response.body?.getReader();
  if (!reader) {
    return {text: '', truncated: false, contentType, finalUrl: response.url || url, status: response.status, headers: response.headers};
  }
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  let read = 0;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > maxBytes) {
      text += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - (read - maxBytes))), {stream: true});
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    text += decoder.decode(value, {stream: true});
  }
  text += decoder.decode();
  return {text, truncated, contentType, finalUrl: response.url || url, status: response.status, headers: response.headers};
}

export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const result = await fetchCapped(url, {
    ...options,
    headers: {accept: 'application/json', ...(options.headers ?? {})},
  });
  try {
    return JSON.parse(result.text) as T;
  } catch (error) {
    throw new JarvisError('UNAVAILABLE', `${options.service ?? 'Service'} returned invalid JSON`, {cause: error});
  }
}

/** POST JSON with standard headers; used by integrations and providers. */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: HttpOptions & {headers?: Record<string, string>} = {},
): Promise<T> {
  return httpJson<T>(url, {
    ...options,
    method: 'POST',
    headers: {'content-type': 'application/json', ...(options.headers ?? {})},
    body: JSON.stringify(body),
  });
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? stripHtml(match[1]).slice(0, 300) : null;
}
