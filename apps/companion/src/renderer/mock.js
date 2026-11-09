'use strict';

/**
 * Browser-only preview bridge. In the packaged Electron app window.jarvis is
 * created by preload.js, so this file is inert. It lets the exact renderer be
 * opened over HTTP for design review and interaction testing.
 */
(function previewBridge() {
  if (window.jarvis) return;
  window.__JARVIS_PREVIEW__ = true;

  const chatListeners = new Set();
  const uiListeners = new Set();
  const pendingApprovals = new Map();
  let memoryCount = 128;
  let conversationId = 'conv_preview';
  let cancelled = false;
  let settings = {
    baseUrl: 'http://127.0.0.1:8765',
    alwaysOnTop: true,
    launchAtLogin: false,
    showOnLaunch: true,
    hotkey: 'CommandOrControl+Shift+J',
    hasToken: false,
    version: '2.0.0',
    platform: 'darwin',
    hotkeyActive: true,
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const emitChat = (requestId, event) => {
    for (const listener of chatListeners) listener({requestId, event});
  };
  const streamText = async (requestId, text) => {
    const words = text.split(/(\s+)/);
    let buffer = '';
    for (let i = 0; i < words.length; i += 1) {
      if (cancelled) return;
      buffer += words[i];
      if (i % 4 === 0) {
        emitChat(requestId, {type: 'text', text: buffer});
        buffer = '';
        await wait(18);
      }
    }
    if (buffer) emitChat(requestId, {type: 'text', text: buffer});
  };
  const approvePromise = (requestId, tool) => {
    const id = `apr_${Date.now()}`;
    return new Promise((resolve) => {
      pendingApprovals.set(id, resolve);
      emitChat(requestId, {
        type: 'approval_required',
        id,
        tool,
        risk: 'external',
        summary: `${tool} (to=team@example.com)`,
        reason: 'This sends something outside JARVIS.',
      });
    });
  };

  async function runChat(requestId, message) {
    cancelled = false;
    emitChat(requestId, {type: 'start', conversationId});
    await wait(420);
    const lower = message.toLowerCase();
    if (lower.includes('email') || lower.includes('send')) {
      emitChat(requestId, {type: 'tool_start', name: 'gmail_send', args: {}});
      await wait(500);
      emitChat(requestId, {type: 'tool_end', name: 'gmail_send', ok: true, summary: 'waiting for approval', durationMs: 500});
      const approved = await approvePromise(requestId, 'gmail_send');
      if (!approved) {
        await streamText(requestId, 'Understood — I did not send it.');
      } else {
        emitChat(requestId, {type: 'tool_start', name: 'gmail_send', args: {}});
        await wait(650);
        emitChat(requestId, {type: 'tool_end', name: 'gmail_send', ok: true, summary: 'message sent', durationMs: 650});
        await streamText(requestId, 'Sent. I kept the draft in your history in case you want to revisit the wording.');
      }
    } else if (lower.includes('remember')) {
      emitChat(requestId, {type: 'tool_start', name: 'remember', args: {}});
      await wait(350);
      memoryCount += 1;
      emitChat(requestId, {type: 'tool_end', name: 'remember', ok: true, summary: 'memory stored', durationMs: 350});
      await streamText(requestId, 'Noted. I will keep that close. Your memory is the one thing I never outsource.');
    } else if (lower.includes('today') || lower.includes('brief') || lower.includes('attention')) {
      emitChat(requestId, {type: 'tool_start', name: 'list_tasks', args: {}});
      await wait(430);
      emitChat(requestId, {type: 'tool_end', name: 'list_tasks', ok: true, summary: '4 open tasks', durationMs: 430});
      emitChat(requestId, {type: 'tool_start', name: 'recall', args: {}});
      await wait(320);
      emitChat(requestId, {type: 'tool_end', name: 'recall', ok: true, summary: '6 memories', durationMs: 320});
      await streamText(
        requestId,
        'A quiet morning, sir. Three things deserve your attention: the passport renewal is due Friday, Maya replied about the cabin and is waiting on you, and the board deck still has two blank slides. I would protect 09:30–11:00 for the deck before the day fills up. Nothing on the calendar before 10:00.',
      );
    } else if (lower.includes('know about me') || lower.includes('profile') || lower.includes('remember about me')) {
      emitChat(requestId, {type: 'tool_start', name: 'get_profile', args: {}});
      await wait(300);
      emitChat(requestId, {type: 'tool_end', name: 'get_profile', ok: true, summary: '18 facts', durationMs: 300});
      await streamText(
        requestId,
        'You are building JARVIS as a local-first chief-of-staff. You live in Berlin, prefer flat whites, protect deep-work mornings, and think in systems rather than tasks. Your inner circle is small and you would rather be asked a precise question than receive a long report. I also know the cabin trip matters to you more than the conference on the same weekend.',
      );
    } else if (lower.includes('week') || lower.includes('plan')) {
      emitChat(requestId, {type: 'tool_start', name: 'calendar_list_events', args: {}});
      await wait(420);
      emitChat(requestId, {type: 'tool_end', name: 'calendar_list_events', ok: true, summary: '7 events', durationMs: 420});
      await streamText(
        requestId,
        'Here is the shape I would choose: Monday for the deck, Tuesday for the two conversations you have been postponing, Wednesday as a buffer, and Friday after 14:00 free for the cabin. I have not moved anything yet — say the word and I will draft the changes for approval.',
      );
    } else {
      emitChat(requestId, {type: 'tool_start', name: 'recall', args: {}});
      await wait(360);
      emitChat(requestId, {type: 'tool_end', name: 'recall', ok: true, summary: 'relevant memory', durationMs: 360});
      await streamText(
        requestId,
        'I am here, sir. I have your memory, your open loops and a reasonably good view of the day. Ask me for the version with fewer words, or tell me what you want done and I will handle the steps.',
      );
    }
    if (!cancelled) emitChat(requestId, {type: 'done', conversationId, text: '', steps: 2, toolCalls: 2});
    emitChat(requestId, {type: 'closed'});
  }

  const api = {
    platform: 'darwin',
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      settings = {...settings, ...patch, hasToken: Boolean(patch.token) || (settings.hasToken && !patch.clearToken)};
      return settings;
    },
    testConnection: async () => ({
      name: 'JARVIS',
      version: '2.0.0',
      model: 'mock/preview',
      provider: 'mock',
      tools: 47,
      counts: {memories: memoryCount, conversations: 6, openTasks: 4, documents: 12, auditEntries: 241},
      timezone: 'Europe/Berlin',
    }),
    startChat: async ({message}) => {
      const requestId = `req_${Date.now()}`;
      setTimeout(() => void runChat(requestId, String(message || '')), 0);
      return {requestId};
    },
    cancelChat: async () => {
      cancelled = true;
      return {ok: true};
    },
    approve: async (id, approved) => {
      const resolve = pendingApprovals.get(id);
      if (resolve) {
        pendingApprovals.delete(id);
        resolve(approved);
      }
      return {ok: true, approved};
    },
    remember: async () => ({id: 'mem_preview', content: 'preview'}),
    captureClipboard: async () => {
      memoryCount += 1;
      return {ok: true, id: 'mem_preview', chars: 84};
    },
    listConversations: async () => [
      {id: 'conv_preview', title: 'Today’s brief and the cabin plan', channel: 'companion', turn_count: 9, updated_at: new Date().toISOString()},
      {id: 'conv_2', title: 'Passport renewal and travel documents', channel: 'cli', turn_count: 4, updated_at: new Date(Date.now() - 86400000).toISOString()},
      {id: 'conv_3', title: 'Board deck narrative', channel: 'api', turn_count: 12, updated_at: new Date(Date.now() - 172800000).toISOString()},
      {id: 'conv_4', title: 'What I know about Mara', channel: 'telegram', turn_count: 3, updated_at: new Date(Date.now() - 604800000).toISOString()},
    ],
    getMessages: async () => [
      {id: 1, role: 'user', content: 'Brief me on today.', created_at: new Date(Date.now() - 3600000).toISOString()},
      {id: 2, role: 'assistant', content: 'Three things deserve your attention: the passport renewal, Maya’s cabin reply, and the board deck. I would protect 09:30–11:00 for the deck.', created_at: new Date(Date.now() - 3500000).toISOString()},
      {id: 3, role: 'user', content: 'Move the deck review to Thursday and keep Friday afternoon free.', created_at: new Date(Date.now() - 1800000).toISOString()},
      {id: 4, role: 'assistant', content: 'I have a proposed change ready. Thursday 14:00 is free; Friday after 14:00 stays protected. I will ask before changing the calendar.', created_at: new Date(Date.now() - 1700000).toISOString()},
    ],
    hide: async () => undefined,
    quit: async () => undefined,
    openExternal: async () => ({ok: true}),
    onChatEvent: (callback) => { chatListeners.add(callback); return () => chatListeners.delete(callback); },
    onUiEvent: (callback) => { uiListeners.add(callback); return () => uiListeners.delete(callback); },
  };

  window.jarvis = api;
})();
