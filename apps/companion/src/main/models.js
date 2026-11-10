'use strict';

const PROVIDERS = new Set(['openai', 'anthropic', 'openrouter', 'google', 'ollama', 'custom']);

const OPENAI_COMPATIBLE_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://127.0.0.1:11434/v1',
  custom: '',
};

function normalizeBaseUrl(raw, fallback) {
  const value = String(raw || '').trim() || fallback;
  if (!value) throw new Error('An API base URL is required for this provider.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid API base URL, for example https://api.openai.com/v1.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API base URLs must use http(s).');
  if (url.username || url.password) throw new Error('Do not put credentials in the API base URL.');
  return url.toString().replace(/\/+$/, '');
}

function extractError(text, status) {
  try {
    const parsed = JSON.parse(text);
    const detail = parsed?.error?.message || parsed?.error || parsed?.message;
    if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 400);
  } catch {
    // fall through
  }
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 200) : `The provider returned HTTP ${status}.`;
}

async function readAnswer(response, provider) {
  const text = await response.text();
  if (!response.ok) {
    const suffix = response.status === 401 ? ' Check that the API key is correct.' : '';
    throw new Error(`${extractError(text, response.status)}${suffix}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('The provider returned an unexpected response.');
  }
  if (provider === 'anthropic') {
    const parts = Array.isArray(payload?.content) ? payload.content : [];
    return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim() || 'OK';
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim() || 'OK';
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('').trim() || 'OK';
  return 'OK';
}

/**
 * Make one tiny completion to prove the key, model and endpoint work.
 * Never stores anything; the caller owns persistence.
 */
async function testModel(options, fetchImpl = fetch) {
  const provider = String(options.provider || '').trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error('Choose a supported model provider.');
  const model = String(options.model || '').trim();
  if (!model) throw new Error('Choose a model.');
  if (model.length > 200) throw new Error('That model name is too long.');
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey && provider !== 'ollama') throw new Error('Paste an API key for this provider.');

  const signal = AbortSignal.timeout(25_000);
  if (provider === 'anthropic') {
    const baseUrl = normalizeBaseUrl(options.apiBaseUrl, 'https://api.anthropic.com');
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{role: 'user', content: 'Reply with exactly: OK'}],
      }),
    }).catch((error) => {
      throw new Error(`Could not reach Anthropic: ${error.message}`);
    });
    const reply = await readAnswer(response, 'anthropic');
    return {ok: true, reply};
  }

  const fallback = OPENAI_COMPATIBLE_DEFAULTS[provider] || '';
  if (!fallback && !String(options.apiBaseUrl || '').trim()) {
    throw new Error('Enter the API base URL for this provider.');
  }
  const baseUrl = normalizeBaseUrl(options.apiBaseUrl, fallback);
  const headers = {'content-type': 'application/json'};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const post = (body) =>
    fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(body),
    }).catch((error) => {
      throw new Error(`Could not reach the model provider: ${error.message}`);
    });

  let response = await post({
    model,
    messages: [{role: 'user', content: 'Reply with exactly: OK'}],
    max_tokens: 16,
    temperature: 0,
  });
  if (response.status === 400) {
    // Some newer OpenAI models reject max_tokens/temperature; retry with a minimal body.
    const text = await response.clone().text();
    if (/max_tokens|max_completion_tokens|temperature|unsupported/i.test(text)) {
      response = await post({model, messages: [{role: 'user', content: 'Reply with exactly: OK'}]});
    }
  }
  const reply = await readAnswer(response, provider);
  return {ok: true, reply};
}

module.exports = {PROVIDERS, OPENAI_COMPATIBLE_DEFAULTS, normalizeBaseUrl, testModel};
