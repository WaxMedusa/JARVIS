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
  view: 'chat',
  notes: [],
  notesQuery: '',
  notesArchived: false,
  notesStats: {active: 0, archived: 0, withAudio: 0},
  notesLoading: false,
  notesRequest: 0,
  notesTimer: null,
  editingNote: null,
  agenda: null,
  agendaLoading: false,
  recorder: null,
  recordingBusy: false,
  recordingContext: null,
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
  modes: $('modes'),
  notesView: $('notes-view'),
  agendaView: $('agenda-view'),
  notesList: $('notes-list'),
  notesSearch: $('notes-search'),
  notesClear: $('notes-clear'),
  notesCount: $('notes-count'),
  notesArchiveToggle: $('notes-archive-toggle'),
  newNote: $('new-note-btn'),
  recordNote: $('record-note-btn'),
  noteRecording: $('note-recording'),
  recordTimer: $('record-timer'),
  recordCancel: $('record-cancel'),
  recordStop: $('record-stop'),
  mic: $('mic-btn'),
  noteSheet: $('note-sheet'),
  noteSheetHeading: $('note-sheet-heading'),
  noteKicker: $('note-kicker'),
  noteForm: $('note-form'),
  noteTitle: $('note-title'),
  noteTags: $('note-tags'),
  noteContent: $('note-content'),
  noteSource: $('note-source'),
  noteUpdated: $('note-updated'),
  noteAudioMeta: $('note-audio-meta'),
  noteResult: $('note-result'),
  notePin: $('note-pin'),
  noteArchive: $('note-archive'),
  noteDelete: $('note-delete'),
  noteCalendar: $('note-calendar'),
  noteSave: $('note-save'),
  agendaList: $('agenda-list'),
  agendaSub: $('agenda-sub'),
  agendaStatus: $('agenda-status'),
  eventSheet: $('event-sheet'),
  eventForm: $('event-form'),
  eventTitle: $('event-title'),
  eventStart: $('event-start'),
  eventEnd: $('event-end'),
  eventLocation: $('event-location'),
  eventDescription: $('event-description'),
  eventResult: $('event-result'),
  eventSave: $('event-save'),
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
  bindCaptureViews();
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
      if (
        !dom.settingsSheet.classList.contains('hidden') ||
        !dom.historySheet.classList.contains('hidden') ||
        !dom.noteSheet.classList.contains('hidden') ||
        !dom.eventSheet.classList.contains('hidden')
      ) closeSheets();
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
  dom.footMeta.textContent = `memory ${formatNumber(counts.memories || 0)} · notes ${formatNumber(counts.notes || 0)} · tools ${formatNumber(status?.tools || 0)}`;
}

function setOffline(message = 'Core offline') {
  state.status = null;
  dom.liveDot.classList.remove('online');
  dom.liveDot.classList.add('offline');
  dom.reactor.classList.remove('thinking');
  dom.reactor.classList.add('offline');
  dom.offline.classList.remove('hidden');
  dom.footState.textContent = 'Offline';
  dom.footMeta.textContent = 'memory — · notes — · tools —';
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
    notes_create: 'Note',
    notes_search: 'Notes search',
    notes_get: 'Note',
    notes_update: 'Note edit',
    notes_append: 'Note edit',
    notes_delete: 'Note delete',
    calendar_create_event: 'Calendar event',
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
      if (state.view === 'notes') void loadNotes();
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
  dom.noteSheet.classList.add('hidden');
  dom.eventSheet.classList.add('hidden');
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
    case 'open-notes':
      switchView('notes');
      break;
    case 'new-note':
      switchView('notes');
      openNewNote();
      break;
    case 'open-agenda':
      switchView('agenda');
      break;
    case 'note-captured':
      toast('Clipboard saved to notes.');
      if (state.view === 'notes') void loadNotes();
      void refreshStatus();
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

/* -------------------------------------------------------------------------- */
/* Notes and agenda                                                           */
/* -------------------------------------------------------------------------- */

function bindCaptureViews() {
  dom.modes?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    switchView(button.getAttribute('data-view'));
  });
  dom.newNote?.addEventListener('click', openNewNote);
  dom.recordNote?.addEventListener('click', () => void toggleRecording('note'));
  dom.mic?.addEventListener('click', () => void toggleRecording('chat'));
  dom.recordStop?.addEventListener('click', () => void stopRecording(false));
  dom.recordCancel?.addEventListener('click', () => void stopRecording(true));
  dom.notesSearch?.addEventListener('input', () => {
    state.notesQuery = dom.notesSearch.value.trim();
    dom.notesClear?.classList.toggle('hidden', !state.notesQuery);
    clearTimeout(state.notesTimer);
    state.notesTimer = setTimeout(() => void loadNotes(), 180);
  });
  dom.notesClear?.addEventListener('click', () => {
    dom.notesSearch.value = '';
    state.notesQuery = '';
    dom.notesClear.classList.add('hidden');
    void loadNotes();
    dom.notesSearch.focus();
  });
  dom.notesArchiveToggle?.addEventListener('click', () => {
    state.notesArchived = !state.notesArchived;
    dom.notesArchiveToggle.setAttribute('aria-pressed', String(state.notesArchived));
    dom.notesArchiveToggle.setAttribute('title', state.notesArchived ? 'Show active notes' : 'Show archived notes');
    dom.notesArchiveToggle.setAttribute('aria-label', state.notesArchived ? 'Show active notes' : 'Show archived notes');
    void loadNotes();
  });
  dom.notesList?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action?.getAttribute('data-action') === 'new-note') {
      openNewNote();
      return;
    }
    if (action?.getAttribute('data-action') === 'retry-notes') {
      void loadNotes();
      return;
    }
    const card = event.target.closest('[data-note-id]');
    if (card) void openNote(card.getAttribute('data-note-id'));
  });
  dom.noteForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveNote();
  });
  $('note-close')?.addEventListener('click', closeSheets);
  dom.notePin?.addEventListener('click', () => void patchEditingNote({pinned: !state.editingNote?.pinned}, state.editingNote?.pinned ? 'Note unpinned.' : 'Note pinned.'));
  dom.noteArchive?.addEventListener('click', () => void archiveEditingNote());
  dom.noteDelete?.addEventListener('click', () => void deleteEditingNote());
  dom.noteCalendar?.addEventListener('click', openNoteInCalendar);
  dom.agendaList?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action?.getAttribute('data-action') === 'retry-agenda') {
      state.agenda = null;
      void loadAgenda();
      return;
    }
    if (action?.getAttribute('data-action') === 'agenda-setup') {
      void bridge?.openExternal('https://github.com/WaxMedusa/JARVIS#google-calendar');
      return;
    }
    if (action?.getAttribute('data-action') === 'new-event') {
      openEventEditor({});
      return;
    }
    const link = event.target.closest('[data-event-link]');
    if (link) void bridge?.openExternal(link.getAttribute('data-event-link'));
  });
  $('agenda-refresh')?.addEventListener('click', () => {
    state.agenda = null;
    void loadAgenda();
  });
  $('new-event-btn')?.addEventListener('click', () => openEventEditor({}));
  dom.eventForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    void createEvent();
  });
  $('event-close')?.addEventListener('click', closeSheets);
  $('event-cancel')?.addEventListener('click', closeSheets);
}

function switchView(view) {
  if (!['chat', 'notes', 'agenda'].includes(view)) view = 'chat';
  if (state.recorder && state.recorder.context !== view) void stopRecording(true);
  state.view = view;
  for (const button of dom.modes?.querySelectorAll('[data-view]') || []) {
    const active = button.getAttribute('data-view') === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  dom.thread.classList.toggle('hidden', view !== 'chat');
  dom.notesView.classList.toggle('hidden', view !== 'notes');
  dom.agendaView.classList.toggle('hidden', view !== 'agenda');
  dom.composer.classList.toggle('hidden', view !== 'chat');
  if (view === 'chat') {
    if (state.pendingApproval) dom.approval.classList.remove('hidden');
    dom.input.focus();
  } else {
    dom.approval.classList.add('hidden');
  }
  if (view === 'notes') void loadNotes();
  if (view === 'agenda') void loadAgenda();
}

async function loadNotes() {
  if (!bridge) return;
  const request = ++state.notesRequest;
  state.notesLoading = true;
  if (!state.notes.length) renderNotesLoading();
  try {
    const result = await bridge.listNotes({
      query: state.notesQuery || undefined,
      archived: state.notesArchived,
      limit: 150,
    });
    if (request !== state.notesRequest) return;
    state.notes = Array.isArray(result?.notes) ? result.notes : [];
    state.notesStats = result?.stats || {
      active: state.notes.filter((note) => !note.archived).length,
      archived: state.notes.filter((note) => note.archived).length,
      withAudio: state.notes.filter((note) => note.audio_path).length,
    };
    renderNotes();
  } catch (error) {
    if (request !== state.notesRequest) return;
    renderNotesError(error.message || 'Could not load notes.');
  } finally {
    if (request === state.notesRequest) state.notesLoading = false;
  }
}

function renderNotesLoading() {
  dom.notesList.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'view-loading';
  const spinner = document.createElement('span');
  spinner.className = 'tool-spinner';
  loading.append(spinner, document.createTextNode(' Reading your notes…'));
  dom.notesList.append(loading);
}

function renderNotesError(message) {
  dom.notesList.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'view-empty';
  const title = document.createElement('strong');
  title.textContent = 'Notes are out of reach';
  const copy = document.createElement('p');
  copy.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ghost';
  retry.setAttribute('data-action', 'retry-notes');
  retry.textContent = 'Try again';
  empty.append(title, copy, retry);
  dom.notesList.append(empty);
}

function renderNotes() {
  const stats = state.notesStats || {active: 0, archived: 0, withAudio: 0};
  dom.notesCount.textContent = state.notesQuery
    ? `${state.notes.length} match${state.notes.length === 1 ? '' : 'es'} in ${state.notesArchived ? 'archive' : 'notes'}`
    : state.notesArchived
      ? `${stats.archived} archived note${stats.archived === 1 ? '' : 's'}`
      : `${stats.active} active · ${stats.withAudio} voice`;
  dom.notesArchiveToggle.setAttribute('aria-pressed', String(state.notesArchived));
  dom.notesList.replaceChildren();

  if (!state.notes.length) {
    const empty = document.createElement('div');
    empty.className = 'view-empty';
    const title = document.createElement('strong');
    title.textContent = state.notesQuery ? 'Nothing matches that search' : state.notesArchived ? 'The archive is empty' : 'A quiet place for everything';
    const copy = document.createElement('p');
    copy.textContent = state.notesQuery
      ? 'Try a shorter phrase, a person’s name, or a tag.'
      : state.notesArchived
        ? 'Notes you archive will wait here, out of the way but never lost.'
        : 'Write a thought, paste something worth keeping, or record a voice note. JARVIS will make it searchable.';
    empty.append(title, copy);
    if (!state.notesQuery && !state.notesArchived) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.setAttribute('data-action', 'new-note');
      button.textContent = 'Write the first note';
      empty.append(button);
    }
    dom.notesList.append(empty);
    return;
  }

  for (const note of state.notes) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `note-card${note.pinned ? ' pinned' : ''}`;
    card.dataset.noteId = note.id;

    const head = document.createElement('div');
    head.className = 'note-card-head';
    const title = document.createElement('span');
    title.className = 'note-card-title';
    title.textContent = note.title || 'Untitled note';
    head.append(title);
    if (note.pinned) {
      const pin = document.createElement('span');
      pin.className = 'note-pin';
      pin.textContent = 'Pinned';
      head.append(pin);
    }
    card.append(head);

    const excerpt = document.createElement('span');
    excerpt.className = 'note-card-excerpt';
    excerpt.textContent = (note.content || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim() || 'No text yet.';
    card.append(excerpt);

    const meta = document.createElement('span');
    meta.className = 'note-card-meta';
    if (note.tags?.length) {
      for (const tag of note.tags.slice(0, 3)) {
        const chip = document.createElement('span');
        chip.className = 'note-tag';
        chip.textContent = `#${tag}`;
        meta.append(chip);
      }
    }
    const date = document.createElement('span');
    date.textContent = formatDate(note.updated_at);
    meta.append(date);
    const source = document.createElement('span');
    source.textContent = `· ${noteSourceLabel(note.source)}`;
    meta.append(source);
    if (note.audio_mime) {
      const audio = document.createElement('span');
      audio.className = 'note-audio-mark';
      audio.textContent = note.duration_seconds ? `· voice ${formatDuration(note.duration_seconds)}` : '· voice';
      meta.append(audio);
    }
    card.append(meta);
    dom.notesList.append(card);
  }
}

function noteSourceLabel(source) {
  const labels = {audio: 'voice note', companion: 'companion', manual: 'written', clipboard: 'clipboard', api: 'api', cli: 'cli'};
  return labels[source] || source || 'note';
}

function openNewNote() {
  state.editingNote = null;
  dom.noteSheetHeading.textContent = 'New note';
  dom.noteKicker.textContent = 'Capture';
  dom.noteTitle.value = '';
  dom.noteTags.value = '';
  dom.noteContent.value = '';
  dom.noteSource.textContent = 'New note';
  dom.noteUpdated.textContent = '';
  dom.noteAudioMeta.textContent = '';
  dom.notePin.textContent = 'Pin';
  dom.noteArchive.textContent = 'Archive';
  dom.notePin.disabled = true;
  dom.noteArchive.disabled = true;
  dom.noteDelete.disabled = true;
  dom.noteCalendar.disabled = true;
  dom.noteSave.disabled = false;
  dom.noteSave.textContent = 'Save note';
  setNoteResult('', '');
  dom.noteSheet.classList.remove('hidden');
  setTimeout(() => dom.noteTitle.focus(), 40);
}

async function openNote(id) {
  if (!bridge || !id) return;
  try {
    let note = state.notes.find((item) => item.id === id);
    if (!note) note = await bridge.getNote(id);
    if (!note) throw new Error('Note not found.');
    fillNoteSheet(note);
  } catch (error) {
    toast(error.message || 'Could not open that note.');
  }
}

function fillNoteSheet(note) {
  state.editingNote = note;
  dom.noteSheetHeading.textContent = note.title || 'Untitled note';
  dom.noteKicker.textContent = note.source === 'audio' ? 'Voice capture' : 'Note';
  dom.noteTitle.value = note.title || '';
  dom.noteTags.value = (note.tags || []).join(', ');
  dom.noteContent.value = note.content || '';
  dom.noteSource.textContent = noteSourceLabel(note.source);
  dom.noteUpdated.textContent = `Updated ${formatDate(note.updated_at)}`;
  dom.noteAudioMeta.textContent = note.audio_mime ? `Voice${note.duration_seconds ? ` · ${formatDuration(note.duration_seconds)}` : ''}` : '';
  dom.notePin.textContent = note.pinned ? 'Unpin' : 'Pin';
  dom.noteArchive.textContent = note.archived ? 'Unarchive' : 'Archive';
  dom.notePin.disabled = false;
  dom.noteArchive.disabled = false;
  dom.noteDelete.disabled = false;
  dom.noteCalendar.disabled = false;
  dom.noteSave.disabled = false;
  dom.noteSave.textContent = 'Save changes';
  setNoteResult('', '');
  dom.noteSheet.classList.remove('hidden');
}

async function saveNote() {
  if (!bridge) return;
  const title = dom.noteTitle.value.trim();
  const content = dom.noteContent.value;
  if (!title && !content.trim()) {
    setNoteResult('Give the note a title or some words first.', 'bad');
    return;
  }
  const tags = dom.noteTags.value.split(',').map((tag) => tag.trim()).filter(Boolean);
  dom.noteSave.disabled = true;
  setNoteResult('Saving…', '');
  try {
    const payload = {title, content, tags, source: 'companion'};
    const note = state.editingNote
      ? await bridge.updateNote(state.editingNote.id, {title, content, tags})
      : await bridge.createNote(payload);
    if (!note) throw new Error('The note could not be saved.');
    state.editingNote = note;
    closeSheets();
    toast('Note saved.');
    await loadNotes();
    void refreshStatus();
  } catch (error) {
    setNoteResult(error.message || 'Could not save the note.', 'bad');
    dom.noteSave.disabled = false;
  }
}

async function patchEditingNote(patch, message) {
  const note = state.editingNote;
  if (!bridge || !note) return;
  try {
    const updated = await bridge.updateNote(note.id, patch);
    if (!updated) throw new Error('The note could not be updated.');
    fillNoteSheet(updated);
    await loadNotes();
    toast(message);
    void refreshStatus();
  } catch (error) {
    setNoteResult(error.message || 'Could not update the note.', 'bad');
  }
}

async function archiveEditingNote() {
  const note = state.editingNote;
  if (!bridge || !note) return;
  try {
    const updated = await bridge.updateNote(note.id, {archived: !note.archived});
    closeSheets();
    await loadNotes();
    toast(updated?.archived ? 'Note archived.' : 'Note restored.');
    void refreshStatus();
  } catch (error) {
    setNoteResult(error.message || 'Could not archive the note.', 'bad');
  }
}

async function deleteEditingNote() {
  const note = state.editingNote;
  if (!bridge || !note) return;
  if (!window.confirm(`Delete “${note.title}”? This cannot be undone.`)) return;
  try {
    await bridge.deleteNote(note.id);
    state.editingNote = null;
    closeSheets();
    await loadNotes();
    toast('Note deleted.');
    void refreshStatus();
  } catch (error) {
    setNoteResult(error.message || 'Could not delete the note.', 'bad');
  }
}

function openNoteInCalendar() {
  const note = state.editingNote;
  if (!note) return;
  const description = note.content.slice(0, 8000);
  closeSheets();
  openEventEditor({summary: note.title, description});
}

function setNoteResult(text, kind) {
  dom.noteResult.classList.add('hidden');
  dom.noteResult.classList.remove('good', 'bad');
  if (!text) return;
  dom.noteResult.textContent = text;
  dom.noteResult.classList.remove('hidden');
  if (kind) dom.noteResult.classList.add(kind);
}

/* -------------------------------------------------------------------------- */
/* Agenda                                                                     */
/* -------------------------------------------------------------------------- */

async function loadAgenda() {
  if (!bridge) return;
  state.agendaLoading = true;
  if (!state.agenda) renderAgendaLoading();
  try {
    const data = await bridge.getCalendar(7);
    state.agenda = data;
    renderAgenda(data);
  } catch (error) {
    state.agenda = null;
    dom.agendaSub.textContent = 'Calendar unavailable';
    dom.agendaStatus.classList.remove('hidden', 'good');
    dom.agendaStatus.classList.add('bad');
    dom.agendaStatus.textContent = error.message || 'Could not reach Google Calendar.';
    dom.agendaList.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'view-empty';
    const title = document.createElement('strong');
    title.textContent = 'The calendar is out of reach';
    const copy = document.createElement('p');
    copy.textContent = 'Check that the JARVIS core is running, then try again.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ghost';
    retry.setAttribute('data-action', 'retry-agenda');
    retry.textContent = 'Try again';
    empty.append(title, copy, retry);
    dom.agendaList.append(empty);
  } finally {
    state.agendaLoading = false;
  }
}

function renderAgendaLoading() {
  dom.agendaList.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'view-loading';
  const spinner = document.createElement('span');
  spinner.className = 'tool-spinner';
  loading.append(spinner, document.createTextNode(' Checking your calendar…'));
  dom.agendaList.append(loading);
}

function renderAgenda(data) {
  dom.agendaStatus.classList.add('hidden');
  dom.agendaStatus.classList.remove('good', 'bad');
  dom.agendaList.replaceChildren();
  if (!data || !data.available || !data.authorized) {
    dom.agendaSub.textContent = 'Google Calendar not connected';
    const connect = document.createElement('div');
    connect.className = 'agenda-connect';
    const title = document.createElement('h3');
    title.textContent = data?.configured ? 'One connection away' : 'Let JARVIS see your time';
    const copy = document.createElement('p');
    copy.textContent = data?.message || 'Set up Google OAuth, then connect your calendar from the terminal.';
    const command = document.createElement('code');
    command.textContent = 'jarvis auth google';
    const guide = document.createElement('button');
    guide.type = 'button';
    guide.className = 'ghost tiny';
    guide.setAttribute('data-action', 'agenda-setup');
    guide.textContent = 'Open setup guide';
    connect.append(title, copy, command, guide);
    dom.agendaList.append(connect);
    return;
  }
  const events = Array.isArray(data.events) ? data.events : [];
  dom.agendaSub.textContent = `${events.length} event${events.length === 1 ? '' : 's'} · next 7 days`;
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'view-empty';
    const title = document.createElement('strong');
    title.textContent = 'A clear stretch of time';
    const copy = document.createElement('p');
    copy.textContent = 'Nothing is on the calendar. Keep it that way, or make a plan worth keeping.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.setAttribute('data-action', 'new-event');
    button.textContent = 'Create an event';
    empty.append(title, copy, button);
    dom.agendaList.append(empty);
    return;
  }

  const groups = new Map();
  for (const event of events) {
    const key = eventDateKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const [key, dayEvents] of groups) {
    const day = document.createElement('section');
    day.className = 'agenda-day';
    const head = document.createElement('div');
    head.className = 'agenda-day-head';
    const name = document.createElement('span');
    name.className = 'agenda-day-name';
    name.textContent = dayLabel(key);
    const date = document.createElement('span');
    date.className = 'agenda-day-date';
    date.textContent = dayDateLabel(key);
    head.append(name, date);
    day.append(head);

    for (const event of dayEvents) {
      const row = document.createElement('div');
      row.className = `agenda-event${isEventNow(event) ? ' now' : ''}`;
      const time = document.createElement('div');
      time.className = 'agenda-time';
      time.style.whiteSpace = 'pre-line';
      time.textContent = eventTimeLabel(event);
      const body = document.createElement('div');
      body.className = 'agenda-event-body';
      const title = document.createElement('div');
      title.className = 'agenda-event-title';
      title.textContent = event.summary || '(untitled event)';
      body.append(title);
      const meta = [];
      if (event.location) meta.push(event.location);
      if (event.attendees?.length) meta.push(`with ${event.attendees.slice(0, 4).join(', ')}`);
      if (meta.length) {
        const detail = document.createElement('div');
        detail.className = 'agenda-event-meta';
        detail.textContent = meta.join(' · ');
        body.append(detail);
      }
      if (event.htmlLink) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'agenda-event-link';
        link.setAttribute('data-event-link', event.htmlLink);
        link.textContent = 'Open in Google Calendar ↗';
        body.append(link);
      }
      row.append(time, body);
      day.append(row);
    }
    dom.agendaList.append(day);
  }
}

function openEventEditor(prefill = {}) {
  dom.eventForm.reset();
  dom.eventTitle.value = prefill.summary || '';
  dom.eventDescription.value = prefill.description || '';
  dom.eventLocation.value = prefill.location || '';
  const start = prefill.start instanceof Date ? prefill.start : nextQuarterHour();
  const end = prefill.end instanceof Date ? prefill.end : new Date(start.getTime() + 60 * 60_000);
  dom.eventStart.value = toLocalInput(start);
  dom.eventEnd.value = toLocalInput(end);
  dom.eventResult.classList.add('hidden');
  dom.eventResult.classList.remove('good', 'bad');
  dom.eventSave.disabled = false;
  dom.eventSheet.classList.remove('hidden');
  setTimeout(() => dom.eventTitle.focus(), 40);
}

async function createEvent() {
  if (!bridge) return;
  const summary = dom.eventTitle.value.trim();
  const start = new Date(dom.eventStart.value);
  const end = new Date(dom.eventEnd.value);
  if (!summary) return setEventResult('Give the event a title.', 'bad');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return setEventResult('Choose a valid start and end time.', 'bad');
  if (end <= start) return setEventResult('The end must be after the start.', 'bad');
  dom.eventSave.disabled = true;
  setEventResult('Creating event…', '');
  try {
    await bridge.createCalendarEvent({
      summary,
      start: start.toISOString(),
      end: end.toISOString(),
      location: dom.eventLocation.value.trim() || undefined,
      description: dom.eventDescription.value.trim() || undefined,
    });
    closeSheets();
    toast('Event created in Google Calendar.');
    state.agenda = null;
    await loadAgenda();
  } catch (error) {
    setEventResult(error.message || 'Could not create the event.', 'bad');
    dom.eventSave.disabled = false;
  }
}

function setEventResult(text, kind) {
  dom.eventResult.classList.add('hidden');
  dom.eventResult.classList.remove('good', 'bad');
  if (!text) return;
  dom.eventResult.textContent = text;
  dom.eventResult.classList.remove('hidden');
  if (kind) dom.eventResult.classList.add(kind);
}

function eventDateKey(event) {
  const raw = String(event.start || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function dayLabel(key) {
  const date = dateFromKey(key);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return date.toLocaleDateString([], {weekday: 'long'});
}

function dayDateLabel(key) {
  return dateFromKey(key).toLocaleDateString([], {month: 'short', day: 'numeric'});
}

function eventTimeLabel(event) {
  const raw = String(event.start || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'All day';
  const start = formatTime(raw);
  const end = formatTime(event.end);
  return end ? `${start}\n${end}` : start;
}

function isEventNow(event) {
  const now = Date.now();
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
}

function nextQuarterHour() {
  const date = new Date();
  date.setSeconds(0, 0);
  date.setMinutes(Math.ceil((date.getMinutes() + 1) / 15) * 15);
  return date;
}

function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* -------------------------------------------------------------------------- */
/* Voice capture                                                              */
/* -------------------------------------------------------------------------- */

async function toggleRecording(context) {
  if (state.recordingBusy) return;
  if (state.recorder) {
    await stopRecording(false);
    return;
  }
  await startRecording(context);
}

async function startRecording(context) {
  if (!bridge) return toast('The companion is not connected.');
  if (state.recordingBusy || state.recorder) return;
  if (context === 'note') switchView('notes');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Microphone recording is not available in this window.');
    return;
  }
  state.recordingBusy = true;
  state.recordingContext = context;
  updateRecordingUi();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    });
    const mimeType = pickAudioMime();
    const recorder = new MediaRecorder(stream, mimeType ? {mimeType, audioBitsPerSecond: 128_000} : undefined);
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    const entry = {
      recorder,
      stream,
      chunks,
      mimeType: mimeType || 'audio/webm',
      context,
      startedAt: Date.now(),
      timer: null,
      maxTimer: null,
      stopping: false,
    };
    state.recorder = entry;
    recorder.start(250);
    entry.timer = setInterval(updateRecordingUi, 250);
    entry.maxTimer = setTimeout(() => void stopRecording(false), 5 * 60 * 1000);
  } catch (error) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    state.recordingBusy = false;
    state.recordingContext = null;
    updateRecordingUi();
    const message = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
      ? 'Microphone access was declined. Allow it in macOS System Settings → Privacy & Security → Microphone.'
      : error?.message || 'Could not start the microphone.';
    toast(message);
  } finally {
    if (state.recorder) {
      state.recordingBusy = false;
      updateRecordingUi();
    }
  }
}

function pickAudioMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const option of options) {
    try {
      if (MediaRecorder.isTypeSupported(option)) return option;
    } catch {
      // try the next format
    }
  }
  return '';
}

async function stopRecording(cancel) {
  const entry = state.recorder;
  if (!entry || entry.stopping) return;
  entry.stopping = true;
  clearInterval(entry.timer);
  clearTimeout(entry.maxTimer);
  state.recordingBusy = true;
  state.recordingContext = entry.context;
  updateRecordingUi();
  try {
    await new Promise((resolve) => {
      entry.recorder.addEventListener('stop', resolve, {once: true});
      try {
        entry.recorder.stop();
      } catch {
        resolve();
      }
    });
  } finally {
    for (const track of entry.stream.getTracks()) track.stop();
    state.recorder = null;
  }
  const duration = Math.max(0, (Date.now() - entry.startedAt) / 1000);
  const mime = entry.mimeType || 'audio/webm';
  const blob = new Blob(entry.chunks, {type: mime.split(';')[0]});
  updateRecordingUi();
  if (cancel) {
    state.recordingBusy = false;
    state.recordingContext = null;
    updateRecordingUi();
    toast('Recording discarded.');
    return;
  }
  if (!blob.size) {
    state.recordingBusy = false;
    state.recordingContext = null;
    updateRecordingUi();
    toast('Nothing was recorded.');
    return;
  }
  try {
    if (entry.context === 'chat') {
      const transcript = await bridge.transcribeAudio({data: await blob.arrayBuffer(), mime, filename: 'dictation.webm'});
      if (!transcript) throw new Error('The transcription was empty. Try again in a quieter place.');
      const existing = dom.input.value.trim();
      dom.input.value = existing ? `${existing} ${transcript}` : transcript;
      autoGrow();
      dom.input.focus();
      toast('Dictation ready.');
    } else {
      const result = await bridge.createAudioNote({
        data: await blob.arrayBuffer(),
        mime,
        filename: `voice-note.${mime.includes('mp4') ? 'm4a' : 'webm'}`,
        durationSeconds: Math.round(duration * 10) / 10,
        summarize: true,
      });
      if (!result?.note) throw new Error('The voice note could not be saved.');
      state.recordingBusy = false;
      state.recordingContext = null;
      updateRecordingUi();
      await loadNotes();
      await openNote(result.note.id);
      toast('Voice note saved.');
      void refreshStatus();
      return;
    }
  } catch (error) {
    toast(error.message || 'Could not transcribe the recording.');
  } finally {
    state.recordingBusy = false;
    state.recordingContext = null;
    updateRecordingUi();
  }
}

function updateRecordingUi() {
  if (!dom.mic) return;
  const active = Boolean(state.recorder);
  const busy = state.recordingBusy;
  const context = state.recorder?.context || state.recordingContext;
  const noteMode = context === 'note' && (active || busy);
  dom.noteRecording.classList.toggle('hidden', !noteMode);
  dom.mic.classList.toggle('recording', active && context === 'chat');
  dom.mic.setAttribute('aria-pressed', String(active && context === 'chat'));
  dom.recordNote.classList.toggle('recording', active && context === 'note');
  dom.recordNote.setAttribute('aria-pressed', String(active && context === 'note'));
  dom.mic.disabled = busy;
  dom.recordNote.disabled = busy;
  dom.recordStop.disabled = !active || busy;
  dom.recordCancel.disabled = !active || busy;
  if (noteMode) {
    dom.recordTitle.textContent = busy ? 'Transcribing and organising…' : 'Listening…';
    dom.recordTimer.textContent = busy ? 'Saving…' : formatDuration(active ? (Date.now() - state.recorder.startedAt) / 1000 : 0);
  }
  if (active && context === 'chat' && !state.streaming) {
    dom.statusLine.textContent = `Listening · ${formatDuration((Date.now() - state.recorder.startedAt) / 1000)}`;
  } else if (!busy && !state.recorder && !state.streaming) {
    dom.statusLine.textContent = statusCaption();
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

init();
