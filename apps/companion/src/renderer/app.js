'use strict';

const bridge = window.jarvis;
const $ = (id) => document.getElementById(id);

const state = {
  messages: [],
  conversationId: null,
  requestId: null,
  streaming: false,
  assistant: null,
  settings: null,
  status: null,
  pendingApproval: null,
  toastTimer: null,
  renderQueued: false,
  unsubChat: null,
  unsubUi: null,
};

const dom = {
  shell: $('shell'),
  reactor: $('reactor'),
  statusLine: $('status-line'),
  thread: $('thread-scroll'),
  messages: $('messages'),
  empty: $('empty-state'),
  greeting: $('greeting'),
  suggestions: $('suggestions'),
  composer: $('composer'),
  input: $('input'),
  send: $('send-btn'),
  offline: $('offline-banner'),
  footState: $('foot-state'),
  footMeta: $('foot-meta'),
  liveDot: $('live-dot'),
  hotkeyHint: $('hotkey-hint'),
  approval: $('approval-card'),
  approvalTitle: $('approval-title'),
  approvalSummary: $('approval-summary'),
  approve: $('approve-btn'),
  deny: $('deny-btn'),
  settingsSheet: $('settings-sheet'),
  historySheet: $('history-sheet'),
  historyList: $('history-list'),
  settingsForm: $('settings-form'),
  settingsUrl: $('setting-url'),
  settingsToken: $('setting-token'),
  settingsClearToken: $('setting-clear-token'),
  settingsTop: $('setting-top'),
  settingsLogin: $('setting-login'),
  settingsLaunch: $('setting-launch'),
  settingsHotkey: $('setting-hotkey'),
  settingsResult: $('settings-result'),
  tokenNote: $('token-note'),
  toast: $('toast'),
};

function init() {
  dom.greeting.textContent = greetingText();
  bindEvents();
  if (!bridge) {
    setOffline('Companion bridge unavailable.');
    return;
  }
  state.unsubChat = bridge.onChatEvent(handleChatEvent);
  state.unsubUi = bridge.onUiEvent(handleUiEvent);
  void loadSettings();
  void refreshStatus();
  dom.input.focus();
  if (window.__JARVIS_PREVIEW__) document.body.classList.add('preview');
}

function bindEvents() {
  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });
  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });
  dom.input.addEventListener('input', autoGrow);
  dom.suggestions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-prompt]');
    if (!button) return;
    dom.input.value = button.getAttribute('data-prompt') || '';
    autoGrow();
    void sendMessage();
  });
  $('history-btn').addEventListener('click', () => void openHistory());
  $('capture-btn').addEventListener('click', () => void captureClipboard());
  $('settings-btn').addEventListener('click', openSettings);
  $('hide-btn').addEventListener('click', () => bridge?.hide());
  dom.offline.addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSheets);
  $('history-close').addEventListener('click', closeSheets);
  $('history-new').addEventListener('click', () => { newConversation(); closeSheets(); });
  dom.settingsForm.addEventListener('submit', (event) => { event.preventDefault(); void saveSettings(false); });
  $('test-btn').addEventListener('click', () => void saveSettings(true));
  $('quit-btn').addEventListener('click', () => bridge?.quit());
  dom.approve.addEventListener('click', () => void resolveApproval(true));
  dom.deny.addEventListener('click', () => void resolveApproval(false));
  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') {
      if (!dom.settingsSheet.classList.contains('hidden') || !dom.historySheet.classList.contains('hidden')) closeSheets();
      else bridge?.hide();
    } else if (meta && event.key === ',') {
      event.preventDefault();
      openSettings();
    } else if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      newConversation();
    }
  });
}

function greetingText() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still awake, sir.';
  if (hour < 12) return 'Good morning, sir.';
  if (hour < 18) return 'Good afternoon, sir.';
  return 'Good evening, sir.';
}

function autoGrow() {
  dom.input.style.height = 'auto';
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, 138)}px`;
}

function setBusy(busy) {
  state.streaming = busy;
  dom.send.disabled = busy;
  dom.input.disabled = false;
  dom.reactor.classList.toggle('thinking', busy);
  dom.statusLine.textContent = busy ? 'Working…' : statusCaption();
}

function statusCaption() {
  if (window.__JARVIS_PREVIEW__) return 'Preview mode · simulated core';
  if (!state.status) return 'Core offline';
  const model = state.status.model || 'local model';
  return `Core online · ${model}`;
}

function setOnline(status) {
  state.status = status;
  dom.liveDot.classList.remove('offline');
  dom.liveDot.classList.add('online');
  dom.reactor.classList.remove('offline');
  dom.offline.classList.add('hidden');
  dom.shell.classList.remove('offline');
  dom.footState.textContent = 'Online';
  dom.statusLine.textContent = statusCaption();
  const counts = status && status.counts ? status.counts : {};
  dom.footMeta.textContent = `memory ${formatNumber(counts.memories || 0)} · tools ${formatNumber(status?.tools || 0)}`;
}

function setOffline(message = 'Core offline') {
  state.status = null;
  dom.liveDot.classList.remove('online');
  dom.liveDot.classList.add('offline');
  dom.reactor.classList.remove('thinking');
  dom.reactor.classList.add('offline');
  dom.offline.classList.remove('hidden');
  dom.footState.textContent = 'Offline';
  dom.footMeta.textContent = 'memory — · tools —';
  dom.statusLine.textContent = message;
}

async function refreshStatus() {
  if (!bridge) return;
  try {
    const status = await bridge.testConnection();
    setOnline(status);
  } catch {
    setOffline('Core offline');
  }
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderThread();
  });
}

function renderThread() {
  const hasMessages = state.messages.length > 0;
  dom.empty.classList.toggle('hidden', hasMessages);
  dom.messages.replaceChildren();
  for (const message of state.messages) dom.messages.append(messageNode(message));
  if (state.streaming) scrollToBottom(false);
}

function messageNode(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role}${message.error ? ' error' : ''}`;
  article.dataset.id = message.id;

  if (message.role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    article.append(avatar);
  }

  const body = document.createElement('div');
  body.className = 'message-body';
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (message.content) {
    bubble.textContent = message.content;
  } else if (message.streaming) {
    const typing = document.createElement('span');
    typing.className = 'typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    bubble.append(typing);
  } else if (!message.tools?.length) {
    bubble.textContent = message.role === 'assistant' ? 'No response.' : '';
  }
  body.append(bubble);

  if (message.tools?.length) {
    const tools = document.createElement('div');
    tools.className = 'tools';
    for (const tool of message.tools) tools.append(toolNode(tool));
    body.append(tools);
  }
  if (message.error) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = message.error;
    body.append(meta);
  } else if (message.role === 'assistant' && !message.streaming) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = message.createdAt ? formatTime(message.createdAt) : '';
    body.append(meta);
  }
  article.append(body);
  return article;
}

function toolNode(tool) {
  const chip = document.createElement('span');
  chip.className = `tool-chip${tool.ok === false ? ' failed' : ''}`;
  if (tool.running) {
    const spinner = document.createElement('span');
    spinner.className = 'tool-spinner';
    chip.append(spinner);
  } else {
    const dot = document.createElement('span');
    dot.className = 'tool-dot';
    chip.append(dot);
  }
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = humanTool(tool.name);
  chip.append(name);
  if (tool.detail) {
    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    detail.textContent = tool.detail;
    chip.append(detail);
  }
  return chip;
}

function humanTool(name) {
  const labels = {
    recall: 'Memory recall',
    remember: 'Memory',
    search_history: 'History',
    web_search: 'Web search',
    web_fetch: 'Web page',
    gmail_search: 'Gmail',
    gmail_read: 'Gmail',
    gmail_send: 'Gmail send',
    calendar_list_events: 'Calendar',
    create_task: 'Task',
    list_tasks: 'Tasks',
    run_shell: 'Shell',
    read_file: 'File',
    write_file: 'File write',
    get_profile: 'Profile',
    update_profile: 'Profile',
  };
  return labels[name] || String(name || 'tool').replace(/_/g, ' ');
}

function scrollToBottom(force) {
  const el = dom.thread;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

function addMessage(role, content, extra = {}) {
  const message = {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    content,
    tools: [],
    streaming: false,
    createdAt: new Date().toISOString(),
    ...extra,
  };
  state.messages.push(message);
  scheduleRender();
  return message;
}

async function sendMessage() {
  if (!bridge || state.streaming) return;
  const message = dom.input.value.trim();
  if (!message) return;
  dom.input.value = '';
  autoGrow();
  addMessage('user', message);
  const assistant = addMessage('assistant', '', {streaming: true});
  state.assistant = assistant;
  state.pendingApproval = null;
  hideApproval();
  setBusy(true);
  scrollToBottom(true);
  try {
    const result = await bridge.startChat({message, conversationId: state.conversationId || undefined});
    state.requestId = result.requestId;
  } catch (error) {
    failAssistant(error.message || 'Could not reach JARVIS.');
  }
}

function handleChatEvent(payload) {
  if (!payload || !payload.event) return;
  if (state.requestId && payload.requestId && payload.requestId !== state.requestId) return;
  if (!state.requestId && payload.requestId) state.requestId = payload.requestId;
  const event = payload.event;
  const assistant = state.assistant;
  if (!assistant) return;

  switch (event.type) {
    case 'start':
      if (event.conversationId) state.conversationId = event.conversationId;
      break;
    case 'text':
      assistant.content += event.text || '';
      scheduleRender();
      scrollToBottom(false);
      break;
    case 'reasoning':
      break;
    case 'tool_start':
      assistant.tools.push({name: event.name, running: true, detail: 'running'});
      scheduleRender();
      scrollToBottom(false);
      break;
    case 'tool_end': {
      const tool = [...assistant.tools].reverse().find((item) => item.running && item.name === event.name);
      if (tool) {
        tool.running = false;
        tool.ok = event.ok !== false;
        tool.detail = event.ok === false ? 'failed' : event.summary || 'done';
      }
      scheduleRender();
      break;
    }
    case 'approval_required':
      state.pendingApproval = event;
      showApproval(event);
      break;
    case 'done':
      if (event.text && !assistant.content.trim()) assistant.content = event.text;
      if (event.conversationId) state.conversationId = event.conversationId;
      finishAssistant();
      void refreshStatus();
      break;
    case 'error':
      failAssistant(event.message || 'JARVIS hit an error.');
      break;
    case 'closed':
      if (state.streaming) finishAssistant();
      break;
    default:
      break;
  }
}

function finishAssistant() {
  const assistant = state.assistant;
  if (assistant) {
    assistant.streaming = false;
    if (!assistant.content && assistant.tools.length) assistant.content = 'Done.';
  }
  state.assistant = null;
  state.requestId = null;
  setBusy(false);
  scheduleRender();
  scrollToBottom(true);
}

function failAssistant(message) {
  const assistant = state.assistant;
  if (assistant) {
    assistant.streaming = false;
    assistant.error = message;
    assistant.content = assistant.content || 'I could not complete that.';
  }
  state.assistant = null;
  state.requestId = null;
  setBusy(false);
  scheduleRender();
}

function showApproval(event) {
  dom.approvalTitle.textContent = `${humanTool(event.tool)} needs approval`;
  dom.approvalSummary.textContent = event.summary || event.reason || 'This action changes something outside JARVIS.';
  dom.approve.disabled = false;
  dom.deny.disabled = false;
  dom.approval.classList.remove('hidden');
  scrollToBottom(true);
}

function hideApproval() {
  dom.approval.classList.add('hidden');
}

async function resolveApproval(approved) {
  const approval = state.pendingApproval;
  if (!approval || !bridge) return;
  dom.approve.disabled = true;
  dom.deny.disabled = true;
  try {
    await bridge.approve(approval.id, approved);
    toast(approved ? 'Approved.' : 'Denied.');
  } catch (error) {
    toast(error.message || 'Approval failed.');
  } finally {
    state.pendingApproval = null;
    hideApproval();
  }
}

async function captureClipboard() {
  if (!bridge) return;
  try {
    const result = await bridge.captureClipboard();
    if (result && result.ok) {
      toast('Clipboard saved to memory.');
      void refreshStatus();
    }
  } catch (error) {
    toast(error.message || 'Could not capture the clipboard.');
  }
}

async function loadSettings() {
  try {
    state.settings = await bridge.getSettings();
    dom.hotkeyHint.textContent = `${formatHotkey(state.settings.hotkey)} to summon`;
    if (window.__JARVIS_PREVIEW__) addPreviewBadge();
  } catch (error) {
    toast(error.message || 'Could not load settings.');
  }
}

function addPreviewBadge() {
  if (document.querySelector('.preview-badge')) return;
  const badge = document.createElement('div');
  badge.className = 'preview-badge';
  badge.textContent = 'Preview';
  dom.shell.append(badge);
}

function openSettings() {
  if (!state.settings && bridge) {
    void loadSettings().then(fillSettings);
  } else {
    fillSettings();
  }
  dom.settingsSheet.classList.remove('hidden');
  dom.settingsResult.classList.add('hidden');
  setTimeout(() => dom.settingsUrl.focus(), 40);
}

function fillSettings() {
  const settings = state.settings || {};
  dom.settingsUrl.value = settings.baseUrl || 'http://127.0.0.1:8765';
  dom.settingsToken.value = '';
  dom.settingsToken.placeholder = settings.hasToken ? '•••••••• saved securely' : 'Only needed for a remote daemon';
  dom.tokenNote.textContent = settings.hasToken
    ? 'A token is saved in encrypted local storage. Leave blank to keep it.'
    : 'Stored encrypted with the macOS Keychain-backed safe storage.';
  dom.settingsClearToken.checked = false;
  dom.settingsTop.checked = Boolean(settings.alwaysOnTop);
  dom.settingsLogin.checked = Boolean(settings.launchAtLogin);
  dom.settingsLaunch.checked = Boolean(settings.showOnLaunch);
  dom.settingsHotkey.value = settings.hotkey || 'CommandOrControl+Shift+J';
}

async function saveSettings(testAfter) {
  if (!bridge) return;
  const payload = {
    baseUrl: dom.settingsUrl.value.trim(),
    alwaysOnTop: dom.settingsTop.checked,
    launchAtLogin: dom.settingsLogin.checked,
    showOnLaunch: dom.settingsLaunch.checked,
    hotkey: dom.settingsHotkey.value.trim(),
    clearToken: dom.settingsClearToken.checked,
  };
  if (dom.settingsToken.value.trim()) payload.token = dom.settingsToken.value.trim();
  setSettingsResult('Saving…', '');
  try {
    const saved = await bridge.saveSettings(payload);
    state.settings = saved;
    dom.hotkeyHint.textContent = `${formatHotkey(saved.hotkey)} to summon`;
    setSettingsResult('Saved.', 'good');
    dom.settingsToken.value = '';
    if (!saved.hotkeyActive) setSettingsResult('Settings saved, but macOS refused that global shortcut. Try another combination.', 'bad');
    await refreshStatus();
    if (testAfter) {
      try {
        const status = await bridge.testConnection();
        const counts = status.counts || {};
        setSettingsResult(`Connected to ${status.name || 'JARVIS'} · ${status.model || 'model'} · ${status.tools || 0} tools · ${counts.memories || 0} memories.`, 'good');
      } catch (error) {
        setSettingsResult(`Saved, but the connection failed: ${error.message}`, 'bad');
      }
    }
  } catch (error) {
    setSettingsResult(error.message || 'Could not save settings.', 'bad');
  }
}

function setSettingsResult(text, kind) {
  dom.settingsResult.classList.remove('hidden', 'good', 'bad');
  if (kind) dom.settingsResult.classList.add(kind);
  dom.settingsResult.textContent = text;
}

function closeSheets() {
  dom.settingsSheet.classList.add('hidden');
  dom.historySheet.classList.add('hidden');
}

async function openHistory() {
  if (!bridge) return;
  dom.historySheet.classList.remove('hidden');
  dom.historyList.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'dim';
  loading.textContent = 'Loading…';
  dom.historyList.append(loading);
  try {
    const conversations = await bridge.listConversations();
    dom.historyList.replaceChildren();
    if (!conversations.length) {
      const empty = document.createElement('p');
      empty.className = 'dim';
      empty.textContent = 'No conversations yet.';
      dom.historyList.append(empty);
      return;
    }
    for (const conversation of conversations) {
      const button = document.createElement('button');
      button.className = 'history-item';
      button.type = 'button';
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = conversation.title || 'Untitled conversation';
      const meta = document.createElement('span');
      meta.className = 'history-meta';
      meta.textContent = `${formatDate(conversation.updated_at)} · ${conversation.channel || 'cli'} · ${conversation.turn_count || 0} turns`;
      button.append(title, meta);
      button.addEventListener('click', () => void loadConversation(conversation.id));
      dom.historyList.append(button);
    }
  } catch (error) {
    dom.historyList.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'dim';
    failed.textContent = error.message || 'Could not load conversations.';
    dom.historyList.append(failed);
  }
}

async function loadConversation(conversationId) {
  if (!bridge) return;
  try {
    const messages = await bridge.getMessages(conversationId);
    state.messages = messages
      .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content)
      .map((message) => ({
        id: `history-${message.id}`,
        role: message.role,
        content: message.content,
        tools: [],
        streaming: false,
        createdAt: message.created_at,
      }));
    state.conversationId = conversationId;
    state.assistant = null;
    state.requestId = null;
    closeSheets();
    scheduleRender();
    scrollToBottom(true);
    toast('Conversation restored.');
  } catch (error) {
    toast(error.message || 'Could not load that conversation.');
  }
}

function newConversation() {
  closeSheets();
  state.messages = [];
  state.conversationId = null;
  state.requestId = null;
  state.assistant = null;
  hideApproval();
  scheduleRender();
  dom.input.focus();
}

function handleUiEvent(payload) {
  if (!payload || !payload.event) return;
  switch (payload.event) {
    case 'new-chat':
      newConversation();
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'focus-input':
      dom.input.focus();
      break;
    case 'captured':
      toast(`Clipboard saved to memory${payload.chars ? ` (${payload.chars} chars)` : ''}.`);
      void refreshStatus();
      break;
    case 'settings-changed':
      if (payload.settings) {
        state.settings = {...state.settings, ...payload.settings};
        dom.hotkeyHint.textContent = `${formatHotkey(state.settings.hotkey)} to summon`;
        if (!dom.settingsSheet.classList.contains('hidden')) fillSettings();
      }
      break;
    case 'error':
      toast(payload.message || 'Something went wrong.');
      break;
    default:
      break;
  }
}

function toast(message) {
  clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  state.toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 3400);
}

function formatHotkey(raw) {
  return String(raw || '')
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, '⌘')
    .replace(/Control|Ctrl/g, '⌃')
    .replace(/Shift/g, '⇧')
    .replace(/Alt|Option/g, '⌥')
    .replace(/\+/g, '');
}

function formatNumber(value) {
  const number = Number(value) || 0;
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
}

function formatDate(raw) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatTime(raw);
  return date.toLocaleDateString([], {month: 'short', day: 'numeric'});
}

function formatTime(raw) {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

init();
