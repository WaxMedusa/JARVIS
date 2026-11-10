'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8765',
  alwaysOnTop: false,
  launchAtLogin: false,
  showOnLaunch: true,
  hotkey: 'CommandOrControl+Shift+J',
  onboarded: false,
  provider: 'openai',
  model: 'gpt-4.1',
  apiBaseUrl: '',
  useExternalDaemon: false,
  canvasBaseUrl: '',
});

const BOOLEAN_KEYS = ['alwaysOnTop', 'launchAtLogin', 'showOnLaunch', 'useExternalDaemon', 'onboarded'];
const PROVIDERS = ['openai', 'anthropic', 'openrouter', 'google', 'ollama', 'custom'];

/** Validate and normalize an http(s) origin or base path. */
function validateBaseUrl(raw, label = 'URL') {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${label} is required.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Enter a valid ${label.toLowerCase()}, for example https://example.com.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Only http:// and https:// ${label.toLowerCase()}s are supported.`);
  }
  if (url.username || url.password) {
    throw new Error(`Do not put credentials in the ${label.toLowerCase()}.`);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function optionalBaseUrl(raw, label, fallback = '') {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  return validateBaseUrl(value, label);
}

function normalizeHotkey(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.length > 80) return DEFAULT_SETTINGS.hotkey;
  return value;
}

function normalizeInput(input, current = DEFAULT_SETTINGS) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...(input && typeof input === 'object' ? input : {}),
  };
  next.baseUrl = validateBaseUrl(next.baseUrl, 'Daemon URL');
  next.apiBaseUrl = optionalBaseUrl(next.apiBaseUrl, 'API base URL');
  next.canvasBaseUrl = optionalBaseUrl(next.canvasBaseUrl, 'Canvas URL');
  next.provider = PROVIDERS.includes(String(next.provider)) ? String(next.provider) : 'openai';
  next.model = String(next.model ?? '').trim().slice(0, 200);
  for (const key of BOOLEAN_KEYS) next[key] = Boolean(next[key]);
  next.hotkey = normalizeHotkey(next.hotkey);
  if (!next.model && next.onboarded) next.onboarded = false;
  return next;
}

function publicSettings(data, flags = {}) {
  return {
    baseUrl: data.baseUrl,
    alwaysOnTop: data.alwaysOnTop,
    launchAtLogin: data.launchAtLogin,
    showOnLaunch: data.showOnLaunch,
    hotkey: data.hotkey,
    onboarded: Boolean(data.onboarded),
    provider: data.provider,
    model: data.model,
    apiBaseUrl: data.apiBaseUrl,
    useExternalDaemon: Boolean(data.useExternalDaemon),
    canvasBaseUrl: data.canvasBaseUrl,
    hasToken: Boolean(flags.hasToken),
    hasApiKey: Boolean(flags.hasApiKey),
    hasCanvasToken: Boolean(flags.hasCanvasToken),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  PROVIDERS,
  validateBaseUrl,
  normalizeHotkey,
  normalizeInput,
  publicSettings,
};
