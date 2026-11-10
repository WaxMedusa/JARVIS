'use strict';

const {
  app,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  clipboard,
  nativeImage,
  safeStorage,
  shell,
  Notification,
  screen,
  session,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {JarvisClient} = require('./jarvis-client');
const {DEFAULT_SETTINGS, normalizeInput, publicSettings, validateBaseUrl} = require('./settings');
const {BackendManager} = require('./backend');
const {testModel} = require('./models');

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 840;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;
const WINDOW_MARGIN = 56;
const MAX_AUDIO_BYTES = 26 * 1024 * 1024;
const BROWSER_HOME = 'https://duckduckgo.com/';
const BROWSER_PARTITION = 'persist:jarvis-browser';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

let win = null;
let tray = null;
let store = null;
let backend = null;
let quitting = false;
let activeHotkey = null;
let boundsTimer = null;
let shutdownStarted = false;
let shutdownComplete = false;
const activeChats = new Map();

let browserView = null;
let browserAttached = false;
let browserVisible = false;
let browserBounds = null;
let browserLastError = '';

/* -------------------------------------------------------------------------- */
/* Secure settings                                                            */
/* -------------------------------------------------------------------------- */

class SettingsStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = {...DEFAULT_SETTINGS, ...this.readFile()};
    try {
      this.data = normalizeInput(this.data, DEFAULT_SETTINGS);
    } catch {
      this.data = {...DEFAULT_SETTINGS};
    }
  }

  readFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), {mode: 0o600});
    fs.renameSync(temp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // best effort on exotic filesystems
    }
  }

  decrypt(value) {
    if (!value || typeof value !== 'string' || !value.startsWith('enc:')) return '';
    if (!safeStorage.isEncryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      return '';
    }
  }

  encrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable. Unlock the macOS Keychain and try again.');
    }
    return `enc:${safeStorage.encryptString(String(value)).toString('base64')}`;
  }

  get token() {
    return this.decrypt(this.data.tokenEnc);
  }

  setToken(token) {
    const value = String(token || '').trim();
    if (!value) return;
    this.data.tokenEnc = this.encrypt(value);
    this.write();
  }

  clearToken() {
    delete this.data.tokenEnc;
    this.write();
  }

  get apiKey() {
    return this.decrypt(this.data.apiKeyEnc);
  }

  setApiKey(value) {
    const key = String(value || '').trim();
    if (!key) return;
    this.data.apiKeyEnc = this.encrypt(key);
    this.write();
  }

  get canvasToken() {
    return this.decrypt(this.data.canvasTokenEnc);
  }

  setCanvasToken(value) {
    const token = String(value || '').trim();
    if (!token) return;
    this.data.canvasTokenEnc = this.encrypt(token);
    this.write();
  }

  clearCanvasToken() {
    delete this.data.canvasTokenEnc;
    this.write();
  }

  save(patch = {}) {
    const allowed = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    const next = normalizeInput(allowed, this.data);
    next.bounds = this.data.bounds;
    next.tokenEnc = this.data.tokenEnc;
    next.apiKeyEnc = this.data.apiKeyEnc;
    next.canvasTokenEnc = this.data.canvasTokenEnc;
    this.data = next;
    this.write();
    return this.data;
  }

  public() {
    return publicSettings(this.data, {
      hasToken: Boolean(this.token),
      hasApiKey: Boolean(this.apiKey),
      hasCanvasToken: Boolean(this.canvasToken),
    });
  }
}

function createClient() {
  return new JarvisClient(
    backend ? backend.clientOptions() : {baseUrl: store.data.baseUrl, token: store.token},
  );
}

function applyLoginItem(value) {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({openAtLogin: Boolean(value), openAsHidden: true});
  } catch {
    // Login item registration can fail outside a signed app bundle.
  }
}

/* -------------------------------------------------------------------------- */
/* Window, tray and hotkey                                                    */
/* -------------------------------------------------------------------------- */

function validBounds(bounds) {
  if (!bounds) return false;
  const values = ['x', 'y', 'width', 'height'].map((key) => Number(bounds[key]));
  if (values.some((value) => !Number.isFinite(value))) return false;
  if (values[2] < 900 || values[3] < 600) return false;
  return screen.getAllDisplays().some(({workArea}) => {
    const [x, y, width, height] = values;
    return x < workArea.x + workArea.width && x + width > workArea.x && y < workArea.y + workArea.height && y + height > workArea.y;
  });
}

function initialBounds() {
  if (validBounds(store.data.bounds)) {
    const {x, y, width, height} = store.data.bounds;
    return {x, y, width, height};
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(WINDOW_WIDTH, Math.max(MIN_WIDTH, area.width - WINDOW_MARGIN));
  const height = Math.min(WINDOW_HEIGHT, Math.max(MIN_HEIGHT, area.height - WINDOW_MARGIN));
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: true,
    backgroundColor: '#0b0d12',
    hasShadow: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    show: false,
    skipTaskbar: false,
    acceptFirstMouse: true,
    alwaysOnTop: store.data.alwaysOnTop,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? {x: 18, y: 20} : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: true,
    },
  });

  win.setTitle('JARVIS');
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(store.data.alwaysOnTop, 'floating');
    win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  } else {
    win.setAlwaysOnTop(store.data.alwaysOnTop);
  }

  win.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return {action: 'deny'};
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.on('render-process-gone', () => {
    if (!quitting) win?.reload();
  });

  win.once('ready-to-show', () => {
    if (store.data.showOnLaunch) showPanel(false);
  });
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('resize', () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      store.data.bounds = win.getBounds();
      try {
        store.write();
      } catch {
        // bounds persistence is best-effort
      }
      sendUi('window-resized');
    }, 400);
  });

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function showPanel(focus = true) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (focus) {
    win.focus();
    if (process.platform === 'darwin') app.focus({steal: true});
    sendUi('focus-input');
  }
}

function togglePanel() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showPanel(true);
}

function sendUi(event, payload = {}) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ui:event', {event, ...payload});
}

function sendChatEvent(requestId, event) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('chat:event', {requestId, event});
}

function setAlwaysOnTop(value) {
  const enabled = Boolean(value);
  store.save({alwaysOnTop: enabled});
  if (win && !win.isDestroyed()) {
    if (process.platform === 'darwin') win.setAlwaysOnTop(enabled, 'floating');
    else win.setAlwaysOnTop(enabled);
  }
  sendUi('settings-changed', {settings: store.public()});
  return enabled;
}

function registerHotkey() {
  if (activeHotkey) {
    globalShortcut.unregister(activeHotkey);
    activeHotkey = null;
  }
  try {
    if (globalShortcut.register(store.data.hotkey, togglePanel)) activeHotkey = store.data.hotkey;
  } catch {
    activeHotkey = null;
  }
  return Boolean(activeHotkey);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'trayTemplate.png');
  const image = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('JARVIS');
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {label: 'Show JARVIS', click: () => showPanel(true)},
    {label: 'New conversation', click: () => { showPanel(true); sendUi('new-chat'); }},
    {label: 'Open browser', click: () => { showPanel(true); sendUi('open-browser'); }},
    {label: 'New note', click: () => { showPanel(true); sendUi('new-note'); }},
    {label: 'Capture clipboard to notes', click: () => { void captureClipboardNote().catch((error) => sendUi('error', {message: error.message})); }},
    {type: 'separator'},
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: Boolean(store.data.alwaysOnTop),
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: Boolean(store.data.launchAtLogin),
      click: (item) => {
        store.save({launchAtLogin: item.checked});
        applyLoginItem(item.checked);
        sendUi('settings-changed', {settings: store.public()});
      },
    },
    {label: 'Settings…', click: () => { showPanel(true); sendUi('open-settings'); }},
    {type: 'separator'},
    {label: 'Quit JARVIS', click: () => { quitting = true; app.quit(); }},
  ]);
}

/* -------------------------------------------------------------------------- */
/* Embedded browser                                                           */
/* -------------------------------------------------------------------------- */

function ensureBrowser() {
  if (browserView) return browserView;
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);

  browserView = new WebContentsView({
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: true,
    },
  });
  const wc = browserView.webContents;
  wc.setUserAgent(BROWSER_USER_AGENT);
  wc.setWindowOpenHandler(({url}) => {
    if (/^https?:\/\//i.test(url)) void wc.loadURL(url);
    return {action: 'deny'};
  });
  wc.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
  const update = () => emitBrowserState();
  for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(name, update);
  }
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    browserLastError = description || 'The page could not be loaded.';
    emitBrowserState();
  });
  wc.on('did-finish-load', () => {
    browserLastError = '';
    emitBrowserState();
  });
  wc.on('render-process-gone', () => {
    browserLastError = 'The page stopped responding.';
    emitBrowserState();
  });
  void wc.loadURL(BROWSER_HOME).catch(() => {});
  return browserView;
}

function browserState() {
  if (!browserView) {
    return {url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: ''};
  }
  const wc = browserView.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    error: browserLastError,
  };
}

function emitBrowserState() {
  sendUi('browser-state', {browser: browserState()});
}

function attachBrowser() {
  if (!browserView || browserAttached || !win || win.isDestroyed()) return;
  win.contentView.addChildView(browserView);
  browserAttached = true;
}

function detachBrowser() {
  if (!browserView || !browserAttached || !win || win.isDestroyed()) return;
  try {
    win.contentView.removeChildView(browserView);
  } catch {
    // the window may already be gone
  }
  browserAttached = false;
}

function normalizeBrowserUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('Enter a URL.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Enter a valid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Only http(s) pages can open in the JARVIS browser.');
    }
    if (url.username || url.password) throw new Error('Do not put credentials in the URL.');
    return url.toString();
  }
  if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(value)) return new URL(`https://${value}`).toString();
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

function setBrowserBounds(payload = {}) {
  const view = ensureBrowser();
  if (!win || win.isDestroyed()) return {ok: false};
  browserVisible = payload.visible === true;
  const width = Number(payload.width);
  const height = Number(payload.height);
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (browserVisible && Number.isFinite(x) && Number.isFinite(y) && width > 20 && height > 20) {
    const [contentWidth, contentHeight] = win.getContentSize();
    browserBounds = {
      x: Math.max(0, Math.min(Math.round(x), contentWidth)),
      y: Math.max(0, Math.min(Math.round(y), contentHeight)),
      width: Math.max(20, Math.min(Math.round(width), contentWidth)),
      height: Math.max(20, Math.min(Math.round(height), contentHeight)),
    };
    view.setBounds(browserBounds);
    attachBrowser();
  } else if (!browserVisible) {
    detachBrowser();
  }
  return {ok: true, visible: browserVisible};
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function captureClipboard() {
  const text = clipboard.readText().trim();
  if (!text) throw new Error('The clipboard is empty.');
  const content = text.slice(0, 8000);
  const memory = await createClient().remember(content, {kind: 'note', importance: 0.55, source: 'companion-clipboard'});
  if (Notification.isSupported()) new Notification({title: 'JARVIS', body: 'Clipboard saved to memory.'}).show();
  sendUi('captured', {id: memory?.id, chars: content.length});
  return {ok: true, id: memory?.id, chars: content.length};
}

async function captureClipboardNote() {
  const text = clipboard.readText().trim();
  if (!text) throw new Error('The clipboard is empty.');
  const content = text.slice(0, 8000);
  const title = content.split(/\r?\n/)[0].replace(/^#+\s*/, '').slice(0, 80) || 'Clipboard note';
  const note = await createClient().createNote({title, content, source: 'clipboard'});
  if (Notification.isSupported()) new Notification({title: 'JARVIS', body: 'Clipboard saved to notes.'}).show();
  sendUi('note-captured', {id: note?.id, title: note?.title});
  return {ok: true, id: note?.id, title: note?.title, chars: content.length};
}

function audioPayload(payload = {}) {
  const data = payload && typeof payload === 'object' ? payload.data : null;
  let buffer;
  if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (typeof data === 'string') buffer = Buffer.from(data, 'base64');
  else throw new Error('Audio data is required.');
  if (!buffer.length) throw new Error('The recording is empty.');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('The recording is too large.');
  const mime = String(payload.mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('audio/') && mime !== 'video/webm' && mime !== 'application/octet-stream') {
    throw new Error('Unsupported audio type.');
  }
  const filename = String(payload.filename || (mime.includes('mp4') ? 'voice-note.m4a' : 'voice-note.webm'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
  return {buffer, mime, filename};
}

function noteInput(payload = {}) {
  const title = String(payload.title || '').trim().slice(0, 200);
  const content = String(payload.content || '').slice(0, 100_000);
  if (!title && !content.trim()) throw new Error('A note needs a title or content.');
  return {
    title,
    content,
    tags: payload.tags,
    pinned: payload.pinned === true,
    source: typeof payload.source === 'string' ? payload.source : 'companion',
  };
}

function notePatch(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid note update.');
  const patch = {};
  if (typeof payload.title === 'string') patch.title = payload.title.slice(0, 200);
  if (typeof payload.content === 'string') patch.content = payload.content.slice(0, 100_000);
  if (payload.tags !== undefined) patch.tags = payload.tags;
  if (typeof payload.pinned === 'boolean') patch.pinned = payload.pinned;
  if (typeof payload.archived === 'boolean') patch.archived = payload.archived;
  return patch;
}

function assertSender(event) {
  if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
    throw new Error('Unauthorized IPC sender.');
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
    return fn(...args);
  });
}

function onboardingState() {
  return {
    needed: !store.data.onboarded,
    provider: store.data.provider,
    model: store.data.model,
    apiBaseUrl: store.data.apiBaseUrl,
    hasApiKey: Boolean(store.apiKey),
    core: backend ? backend.snapshot() : null,
  };
}

function settingsPayload() {
  return {
    ...store.public(),
    version: app.getVersion(),
    platform: process.platform,
    hotkeyActive: Boolean(activeHotkey),
    core: backend ? backend.snapshot() : null,
    onboarding: onboardingState(),
  };
}

async function completeOnboarding(payload = {}) {
  const provider = ['openai', 'anthropic', 'openrouter', 'google', 'ollama', 'custom'].includes(payload.provider)
    ? payload.provider
    : store.data.provider;
  const model = String(payload.model || '').trim().slice(0, 200);
  const apiBaseUrl = String(payload.apiBaseUrl || '').trim();
  const enteredKey = String(payload.apiKey || '').trim();
  const apiKey = enteredKey || (provider === store.data.provider ? store.apiKey : '');
  if (!model) throw new Error('Choose a model first.');
  if (provider !== 'ollama' && !apiKey) throw new Error('Paste an API key for this provider.');
  await testModel({provider, model, apiKey, apiBaseUrl});
  if (enteredKey) store.setApiKey(enteredKey);
  store.save({provider, model, apiBaseUrl, onboarded: true});
  const core = await backend.restart();
  if (core.state !== 'online') throw new Error(core.message || 'JARVIS core did not start.');
  return {settings: settingsPayload(), core};
}

async function connectCanvas(payload = {}) {
  const baseUrl = validateBaseUrl(String(payload.baseUrl || '').trim(), 'Canvas URL');
  const token = String(payload.token || '').trim() || store.canvasToken;
  if (!token) throw new Error('Paste a Canvas API token.');
  store.setCanvasToken(token);
  store.save({canvasBaseUrl: baseUrl});
  const core = backend.state === 'online' ? await backend.restart() : await backend.start();
  if (core.state !== 'online') throw new Error(core.message || 'JARVIS core did not restart.');
  return createClient().canvas();
}

function registerIpc() {
  handle('settings:get', () => settingsPayload());

  handle('settings:save', (payload = {}) => {
    payload = payload && typeof payload === 'object' ? payload : {};
    const previousExternal = store.data.useExternalDaemon;
    const previousUrl = store.data.baseUrl;
    const saved = store.save(payload || {});
    if (typeof payload.token === 'string' && payload.token.trim()) store.setToken(payload.token);
    if (payload.clearToken === true) store.clearToken();
    applyLoginItem(saved.launchAtLogin);
    if (win && !win.isDestroyed()) {
      if (process.platform === 'darwin') win.setAlwaysOnTop(saved.alwaysOnTop, 'floating');
      else win.setAlwaysOnTop(saved.alwaysOnTop);
    }
    const hotkeyActive = registerHotkey();
    if (previousExternal !== saved.useExternalDaemon || previousUrl !== saved.baseUrl) {
      void backend.restart();
    }
    return {...settingsPayload(), hotkeyActive};
  });

  handle('core:state', () => (backend ? backend.snapshot() : {state: 'stopped', message: 'JARVIS core is stopped.'}));
  handle('core:restart', () => backend.restart());

  handle('onboarding:state', () => onboardingState());
  handle('onboarding:test', (payload = {}) =>
    testModel({
      provider: payload.provider,
      model: payload.model,
      apiKey: payload.apiKey,
      apiBaseUrl: payload.apiBaseUrl,
    }),
  );
  handle('onboarding:complete', (payload) => completeOnboarding(payload || {}));
  handle('onboarding:reset', () => {
    store.save({onboarded: false});
    return onboardingState();
  });

  handle('jarvis:status', () => createClient().status());
  handle('jarvis:remember', (content) => {
    const text = String(content || '').trim();
    if (!text) throw new Error('Nothing to remember.');
    return createClient().remember(text, {kind: 'note', importance: 0.6, source: 'companion'});
  });
  handle('jarvis:conversations', () => createClient().conversations());
  handle('jarvis:messages', (conversationId) => {
    if (typeof conversationId !== 'string' || !conversationId) throw new Error('Conversation id is required.');
    return createClient().messages(conversationId);
  });
  handle('notes:list', (options = {}) => {
    const safe = options && typeof options === 'object' ? options : {};
    return createClient().notes({
      query: typeof safe.query === 'string' ? safe.query.slice(0, 300) : undefined,
      tag: typeof safe.tag === 'string' ? safe.tag.slice(0, 40) : undefined,
      archived: safe.archived === true,
      limit: Number.isFinite(Number(safe.limit)) ? Math.min(Math.max(Number(safe.limit), 1), 200) : 100,
    });
  });
  handle('notes:get', (id) => {
    if (typeof id !== 'string' || !id) throw new Error('Note id is required.');
    return createClient().note(id);
  });
  handle('notes:create', (payload) => createClient().createNote(noteInput(payload)));
  handle('notes:update', (payload = {}) => {
    if (!payload || typeof payload.id !== 'string' || !payload.id) throw new Error('Note id is required.');
    return createClient().updateNote(payload.id, notePatch(payload.patch));
  });
  handle('notes:delete', (id) => {
    if (typeof id !== 'string' || !id) throw new Error('Note id is required.');
    return createClient().deleteNote(id);
  });
  handle('calendar:list', (days = 7) => createClient().calendar(Math.min(Math.max(Number(days) || 7, 1), 60)));
  handle('calendar:create', (payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid event.');
    const summary = String(payload.summary || '').trim();
    const start = String(payload.start || '');
    const end = String(payload.end || '');
    if (!summary) throw new Error('Event title is required.');
    if (!start || !end) throw new Error('Event start and end are required.');
    return createClient().createCalendarEvent({
      summary: summary.slice(0, 300),
      start,
      end,
      description: typeof payload.description === 'string' ? payload.description.slice(0, 8000) : undefined,
      location: typeof payload.location === 'string' ? payload.location.slice(0, 500) : undefined,
      attendees: Array.isArray(payload.attendees) ? payload.attendees : undefined,
    });
  });
  handle('calendar:feeds', () => createClient().calendarFeeds());
  handle('calendar:add-feed', (payload = {}) => {
    const url = String(payload.url || '').trim();
    if (!url) throw new Error('Paste the private iCal address of your calendar.');
    return createClient().addCalendarFeed({
      url,
      label: typeof payload.label === 'string' ? payload.label.slice(0, 80) : undefined,
    });
  });
  handle('calendar:remove-feed', (id) => {
    if (typeof id !== 'string' || !id) throw new Error('Calendar id is required.');
    return createClient().removeCalendarFeed(id);
  });

  handle('canvas:summary', () => createClient().canvas());
  handle('canvas:assignments', (payload = {}) => {
    const courseId = String(payload.courseId || '');
    if (!courseId) throw new Error('Choose a Canvas course first.');
    return createClient().canvasAssignments(courseId, payload.bucket || 'upcoming');
  });
  handle('canvas:connect', (payload) => connectCanvas(payload || {}));
  handle('canvas:disconnect', async () => {
    store.clearCanvasToken();
    store.save({canvasBaseUrl: ''});
    const core = await backend.restart();
    return {core, settings: settingsPayload()};
  });

  handle('audio:transcribe', (payload) => createClient().transcribeAudio(audioPayload(payload)));
  handle('audio:note', (payload = {}) => {
    const audio = audioPayload(payload);
    return createClient().createAudioNote({
      ...audio,
      title: typeof payload.title === 'string' ? payload.title.slice(0, 200) : undefined,
      tags: payload.tags,
      durationSeconds: Number(payload.durationSeconds) || undefined,
      summarize: payload.summarize !== false,
    });
  });
  handle('app:capture-clipboard-note', () => captureClipboardNote());
  handle('jarvis:approve', (payload = {}) => {
    if (typeof payload.id !== 'string' || !payload.id) throw new Error('Approval id is required.');
    return createClient().approve(payload.id, payload.approved === true);
  });

  handle('browser:navigate', async (raw) => {
    const url = normalizeBrowserUrl(raw);
    const view = ensureBrowser();
    browserLastError = '';
    await view.webContents.loadURL(url);
    if (browserVisible && browserBounds) attachBrowser();
    emitBrowserState();
    return browserState();
  });
  handle('browser:back', () => {
    if (browserView?.webContents.canGoBack()) browserView.webContents.goBack();
    return browserState();
  });
  handle('browser:forward', () => {
    if (browserView?.webContents.canGoForward()) browserView.webContents.goForward();
    return browserState();
  });
  handle('browser:reload', () => {
    browserView?.webContents.reload();
    return browserState();
  });
  handle('browser:stop', () => {
    browserView?.webContents.stop();
    return browserState();
  });
  handle('browser:set-bounds', (payload) => setBrowserBounds(payload || {}));
  handle('browser:context', async () => {
    if (!browserView) throw new Error('Open the JARVIS browser first.');
    const wc = browserView.webContents;
    const url = wc.getURL();
    if (!url) throw new Error('Open a page in the JARVIS browser first.');
    const result = await wc.executeJavaScript(
      `(() => {
        const body = document.body;
        const text = (body ? body.innerText : '').replace(/\\s+/g, ' ').trim();
        return {url: location.href, title: document.title || '', text: text.slice(0, 20000)};
      })()`,
      true,
    );
    return {
      url: String(result?.url || url).slice(0, 2000),
      title: String(result?.title || '').slice(0, 300),
      text: String(result?.text || '').slice(0, 20000),
    };
  });
  handle('browser:open-external', async () => {
    const url = browserView?.webContents.getURL() || '';
    if (!/^https?:\/\//i.test(url)) throw new Error('Nothing to open.');
    await shell.openExternal(url);
    return {ok: true};
  });

  handle('app:capture-clipboard', () => captureClipboard());
  handle('app:open-external', async (raw) => {
    let url;
    try {
      url = new URL(String(raw || ''));
    } catch {
      throw new Error('Invalid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Only public http(s) links can be opened.');
    }
    await shell.openExternal(url.toString());
    return {ok: true};
  });
  handle('window:hide', () => win?.hide());
  handle('app:quit', () => {
    quitting = true;
    app.quit();
  });

  handle('chat:start', (payload = {}) => {
    const message = String(payload.message || '').trim();
    if (!message) throw new Error('Message is empty.');
    if (message.length > 48_000) throw new Error('Message is too long.');
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    activeChats.set(requestId, controller);
    const client = createClient();
    setImmediate(async () => {
      try {
        await client.chat({
          message,
          conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
          signal: controller.signal,
          onEvent: (event) => sendChatEvent(requestId, event),
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          sendChatEvent(requestId, {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        activeChats.delete(requestId);
        sendChatEvent(requestId, {type: 'closed'});
      }
    });
    return {requestId};
  });

  handle('chat:cancel', (requestId) => {
    const controller = activeChats.get(String(requestId || ''));
    if (controller) controller.abort();
    return {ok: Boolean(controller)};
  });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel(true));

  app.whenReady().then(() => {
    app.setName('JARVIS');
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular');
      app.dock?.show();
    }
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const audioOnly = types.length === 0 || types.every((type) => type === 'audio');
      const allowed = permission === 'media' && audioOnly && Boolean(win && !win.isDestroyed() && webContents === win.webContents);
      callback(allowed);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
      if (permission !== 'media' || !win || win.isDestroyed() || webContents !== win.webContents) return false;
      return !details?.mediaType || details.mediaType === 'audio';
    });

    store = new SettingsStore();
    backend = new BackendManager({
      appRoot: path.resolve(__dirname, '..', '..', '..', '..'),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
      getSettings: () => store.data,
      getApiKey: () => store.apiKey,
      getCanvasToken: () => store.canvasToken,
      getExternalToken: () => store.token,
      onState: (snapshot) => sendUi('core-state', {core: snapshot}),
    });

    registerIpc();
    createWindow();
    createTray();
    registerHotkey();
    applyLoginItem(store.data.launchAtLogin);

    if (process.argv.includes('--dev')) win?.webContents.openDevTools({mode: 'detach'});
    if (store.data.onboarded) void backend.start();
  }).catch((error) => {
    console.error('Failed to start JARVIS Companion:', error);
    app.quit();
  });

  app.on('activate', () => showPanel(true));
  app.on('window-all-closed', () => {
    // Menu-bar app: closing the window should not terminate the core.
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const controller of activeChats.values()) controller.abort();
    activeChats.clear();
    globalShortcut.unregisterAll();
    detachBrowser();
    if (browserView && !browserView.webContents.isDestroyed()) {
      try {
        browserView.webContents.close();
      } catch {
        // already gone
      }
    }
    Promise.resolve(backend ? backend.stop() : null).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
}
