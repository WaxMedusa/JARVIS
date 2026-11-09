'use strict';

const {
  app,
  BrowserWindow,
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
const {DEFAULT_SETTINGS, normalizeInput, publicSettings} = require('./settings');

const PANEL_WIDTH = 392;
const PANEL_HEIGHT = 620;
const PANEL_MARGIN = 18;

let win = null;
let tray = null;
let store = null;
let quitting = false;
let activeHotkey = null;
let boundsTimer = null;
const activeChats = new Map();

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

  get token() {
    const encrypted = this.data.tokenEnc;
    if (!encrypted || typeof encrypted !== 'string' || !encrypted.startsWith('enc:')) return '';
    try {
      return safeStorage.decryptString(Buffer.from(encrypted.slice(4), 'base64'));
    } catch {
      return '';
    }
  }

  setToken(token) {
    const value = String(token || '').trim();
    if (!value) return;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this Mac.');
    }
    this.data.tokenEnc = `enc:${safeStorage.encryptString(value).toString('base64')}`;
    this.write();
  }

  clearToken() {
    delete this.data.tokenEnc;
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
    this.data = next;
    this.write();
    return this.data;
  }

  public() {
    return publicSettings(this.data, Boolean(this.token));
  }
}

function createClient() {
  return new JarvisClient({
    baseUrl: store.data.baseUrl,
    token: store.token,
  });
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
  if (values[2] < 320 || values[3] < 420) return false;
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
  return {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    x: Math.round(area.x + area.width - PANEL_WIDTH - PANEL_MARGIN),
    y: Math.round(area.y + area.height - PANEL_HEIGHT - PANEL_MARGIN),
  };
}

function createWindow() {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 440,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    resizable: true,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    alwaysOnTop: store.data.alwaysOnTop,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: true,
    },
  });

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
  win.on('moved', () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      store.data.bounds = win.getBounds();
      try {
        store.write();
      } catch {
        // bounds persistence is best-effort
      }
    }, 500);
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
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showPanel(true);
  }
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
    if (globalShortcut.register(store.data.hotkey, togglePanel)) {
      activeHotkey = store.data.hotkey;
    }
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
    {label: 'Summon JARVIS', click: () => showPanel(true)},
    {label: 'New conversation', click: () => { showPanel(true); sendUi('new-chat'); }},
    {label: 'Capture clipboard to memory', click: () => { void captureClipboard().catch((error) => sendUi('error', {message: error.message})); }},
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
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function captureClipboard() {
  const text = clipboard.readText().trim();
  if (!text) throw new Error('The clipboard is empty.');
  const content = text.slice(0, 8000);
  const memory = await createClient().remember(content, {kind: 'note', importance: 0.55, source: 'companion-clipboard'});
  if (Notification.isSupported()) {
    new Notification({title: 'JARVIS', body: 'Clipboard saved to memory.'}).show();
  }
  sendUi('captured', {id: memory?.id, chars: content.length});
  return {ok: true, id: memory?.id, chars: content.length};
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

function registerIpc() {
  handle('settings:get', () => ({
    ...store.public(),
    version: app.getVersion(),
    platform: process.platform,
    hotkeyActive: Boolean(activeHotkey),
  }));

  handle('settings:save', (payload = {}) => {
    const saved = store.save(payload || {});
    if (typeof payload.token === 'string' && payload.token.trim()) store.setToken(payload.token);
    if (payload.clearToken === true) store.clearToken();
    applyLoginItem(saved.launchAtLogin);
    if (win && !win.isDestroyed()) {
      if (process.platform === 'darwin') win.setAlwaysOnTop(saved.alwaysOnTop, 'floating');
      else win.setAlwaysOnTop(saved.alwaysOnTop);
    }
    const hotkeyActive = registerHotkey();
    return {...store.public(), version: app.getVersion(), platform: process.platform, hotkeyActive};
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
  handle('jarvis:approve', (payload = {}) => {
    if (typeof payload.id !== 'string' || !payload.id) throw new Error('Approval id is required.');
    return createClient().approve(payload.id, payload.approved === true);
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
    if (message.length > 32000) throw new Error('Message is too long.');
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
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    store = new SettingsStore();
    registerIpc();
    createWindow();
    createTray();
    registerHotkey();
    applyLoginItem(store.data.launchAtLogin);

    if (process.argv.includes('--dev')) win?.webContents.openDevTools({mode: 'detach'});
  }).catch((error) => {
    console.error('Failed to start JARVIS Companion:', error);
    app.quit();
  });

  app.on('activate', () => showPanel(true));
  app.on('window-all-closed', () => {
    // Menu-bar app: closing the panel should not terminate the process.
  });
  app.on('before-quit', () => {
    quitting = true;
    for (const controller of activeChats.values()) controller.abort();
    activeChats.clear();
    globalShortcut.unregisterAll();
  });
}
