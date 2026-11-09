'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8765',
  alwaysOnTop: true,
  launchAtLogin: false,
  showOnLaunch: true,
  hotkey: 'CommandOrControl+Shift+J',
});

const BOOLEAN_KEYS = ['alwaysOnTop', 'launchAtLogin', 'showOnLaunch'];

/** Validate and normalize the daemon origin. Paths are allowed for reverse proxies. */
function validateBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('Daemon URL is required.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid URL, for example http://127.0.0.1:8765.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// daemon URLs are supported.');
  }
  if (url.username || url.password) {
    throw new Error('Do not put credentials in the URL. Use the API token field.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
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
  next.baseUrl = validateBaseUrl(next.baseUrl);
  for (const key of BOOLEAN_KEYS) next[key] = Boolean(next[key]);
  next.hotkey = normalizeHotkey(next.hotkey);
  return next;
}

function publicSettings(data, hasToken) {
  return {
    baseUrl: data.baseUrl,
    alwaysOnTop: data.alwaysOnTop,
    launchAtLogin: data.launchAtLogin,
    showOnLaunch: data.showOnLaunch,
    hotkey: data.hotkey,
    hasToken: Boolean(hasToken),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  validateBaseUrl,
  normalizeHotkey,
  normalizeInput,
  publicSettings,
};
