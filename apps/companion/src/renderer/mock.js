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
  let notes = [
    {
      id: 'note_preview_1',
      title: 'Cabin weekend — what matters',
      content: 'Maya is waiting on a decision about the cabin. The dates are 21–23 November. Keep Friday afternoon free for the drive; the conference can be a Saturday morning call instead.\n\nBook the train, then send Maya the arrival time.',
      summary: 'Cabin trip 21–23 November. Protect Friday afternoon and confirm with Maya.',
      tags: ['personal', 'travel'],
      source: 'companion',
      audio_path: null,
      audio_mime: null,
      duration_seconds: null,
      pinned: true,
      archived: false,
      created_at: new Date(Date.now() - 5_400_000).toISOString(),
      updated_at: new Date(Date.now() - 1_800_000).toISOString(),
    },
    {
      id: 'note_preview_2',
      title: 'Board deck narrative',
      content: 'The deck needs a cleaner through-line: the market shift, the product bet, the proof, then the ask. Two blank slides remain: competitive landscape and the three-year model. Ask Priya for the retention chart before Thursday.',
      summary: null,
      tags: ['work', 'board'],
      source: 'audio',
      audio_path: 'note_preview_2.webm',
      audio_mime: 'audio/webm',
      duration_seconds: 42,
      pinned: false,
      archived: false,
      created_at: new Date(Date.now() - 19_800_000).toISOString(),
      updated_at: new Date(Date.now() - 19_800_000).toISOString(),
    },
    {
      id: 'note_preview_3',
      title: 'Espresso dial-in',
      content: '18g in, 36g out, 27 seconds. Slightly brighter than last week; keep the temperature at 93°C and grind one notch finer tomorrow.',
      summary: null,
      tags: ['home', 'coffee'],
      source: 'manual',
      audio_path: null,
      audio_mime: null,
      duration_seconds: null,
      pinned: false,
      archived: false,
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
      updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
    {
      id: 'note_preview_4',
      title: 'Old passport checklist',
      content: 'Renewed in September. The old checklist is kept only for the visa history.',
      summary: null,
      tags: ['admin'],
      source: 'clipboard',
      audio_path: null,
      audio_mime: null,
      duration_seconds: null,
      pinned: false,
      archived: true,
      created_at: new Date(Date.now() - 604_800_000).toISOString(),
      updated_at: new Date(Date.now() - 604_800_000).toISOString(),
    },
  ];
  const event = (dayOffset, hour, minute, durationMinutes, summary, location, attendees) => {
    const start = new Date();
    start.setDate(start.getDate() + dayOffset);
    start.setHours(hour, minute, 0, 0);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    return {
      id: `evt_${dayOffset}_${hour}_${minute}`,
      summary,
      start: start.toISOString(),
      end: end.toISOString(),
      location,
      htmlLink: 'https://calendar.google.com/',
      attendees: attendees || [],
    };
  };
  let calendarEvents = [
    event(0, 9, 30, 45, 'Product review', 'Studio · 3rd floor', ['Priya', 'Tom']),
    event(0, 13, 0, 60, 'Lunch with Maya', 'Café Krokodil', ['Maya']),
    event(1, 10, 0, 30, 'Board deck working session', 'Study', []),
    event(1, 16, 0, 45, 'Design critique', 'Studio', ['Lena', 'Tom', 'Priya']),
    event(2, 8, 30, 30, 'Dentist', 'Mitte', []),
    event(4, 14, 0, 90, 'Quarterly planning', 'Studio · main room', ['Priya', 'Lena', 'Tom']),
  ];
  let settings = {
    baseUrl: 'http://127.0.0.1:8765',
    alwaysOnTop: true,
    launchAtLogin: false,
    showOnLaunch: true,
    hotkey: 'CommandOrControl+Shift+J',
    onboarded: true,
    provider: 'openai',
    model: 'gpt-5.1',
    apiBaseUrl: '',
    useExternalDaemon: false,
    canvasBaseUrl: 'https://canvas.example.edu',
    hasToken: false,
    hasApiKey: true,
    hasCanvasToken: true,
    version: '3.0.0',
    platform: 'darwin',
    hotkeyActive: true,
    core: {state: 'online', message: 'Preview core is online.', managed: true},
    onboarding: {needed: false, provider: 'openai', model: 'gpt-5.1', hasApiKey: true},
  };
  let browser = {
    url: 'https://calendar.google.com/calendar/u/0/r/week',
    title: 'Google Calendar — Week',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    error: '',
  };
  const canvasAssignments = [
    {id: 'a1', name: 'Board deck narrative — final pass', courseName: 'Product Strategy', dueAt: new Date(Date.now() + 86_400_000).toISOString(), pointsPossible: 100, submitted: false, url: 'https://canvas.example.edu/courses/1/assignments/1'},
    {id: 'a2', name: 'Case study: retention economics', courseName: 'Growth', dueAt: new Date(Date.now() + 172_800_000).toISOString(), pointsPossible: 40, submitted: false, url: 'https://canvas.example.edu/courses/2/assignments/2'},
    {id: 'a3', name: 'Reading response — systems thinking', courseName: 'Systems', dueAt: new Date(Date.now() + 259_200_000).toISOString(), pointsPossible: 20, submitted: true, url: 'https://canvas.example.edu/courses/3/assignments/3'},
    {id: 'a4', name: 'Midterm outline', courseName: 'Product Strategy', dueAt: new Date(Date.now() + 432_000_000).toISOString(), pointsPossible: 50, submitted: false, url: 'https://canvas.example.edu/courses/1/assignments/4'},
  ];
  const canvasData = {
    available: true,
    configured: true,
    profile: {connected: true, name: 'Alex Morgan', email: 'alex@school.edu'},
    courses: [
      {id: '1', name: 'Product Strategy', courseCode: 'BUS 412', term: 'Fall 2026', url: 'https://canvas.example.edu/courses/1'},
      {id: '2', name: 'Growth', courseCode: 'MKT 308', term: 'Fall 2026', url: 'https://canvas.example.edu/courses/2'},
      {id: '3', name: 'Systems', courseCode: 'DES 220', term: 'Fall 2026', url: 'https://canvas.example.edu/courses/3'},
    ],
    upcoming: canvasAssignments.filter((item) => !item.submitted),
    todo: canvasAssignments.filter((item) => !item.submitted).slice(0, 3),
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
      version: '3.0.0',
      model: 'mock/preview',
      provider: 'mock',
      tools: 53,
      counts: {memories: memoryCount, conversations: 6, openTasks: 4, documents: 12, auditEntries: 241, notes: notes.filter((note) => !note.archived).length},
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
    listNotes: async (options = {}) => {
      const archived = options.archived === true;
      const query = String(options.query || '').trim().toLowerCase();
      const filtered = notes.filter((note) => {
        if (Boolean(note.archived) !== archived) return false;
        if (!query) return true;
        return `${note.title} ${note.content} ${note.tags.join(' ')}`.toLowerCase().includes(query);
      });
      const tags = [...new Set(notes.filter((note) => !note.archived).flatMap((note) => note.tags))].sort();
      return {
        notes: filtered,
        tags,
        stats: {
          active: notes.filter((note) => !note.archived).length,
          archived: notes.filter((note) => note.archived).length,
          withAudio: notes.filter((note) => note.audio_mime).length,
        },
        archived,
      };
    },
    getNote: async (id) => {
      const note = notes.find((item) => item.id === id);
      if (!note) throw new Error('Note not found.');
      return note;
    },
    createNote: async (input = {}) => {
      await wait(160);
      const content = String(input.content || '');
      const title = String(input.title || '').trim() || content.split(/\r?\n/)[0].slice(0, 80) || 'Untitled note';
      const note = {
        id: `note_preview_${Date.now()}`,
        title,
        content,
        summary: null,
        tags: Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
        source: input.source || 'companion',
        audio_path: null,
        audio_mime: null,
        duration_seconds: null,
        pinned: Boolean(input.pinned),
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      notes.unshift(note);
      return note;
    },
    updateNote: async (id, patch = {}) => {
      await wait(120);
      const index = notes.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('Note not found.');
      notes[index] = {...notes[index], ...patch, updated_at: new Date().toISOString()};
      return notes[index];
    },
    deleteNote: async (id) => {
      notes = notes.filter((note) => note.id !== id);
      return {ok: true};
    },
    getCalendar: async () => {
      await wait(260);
      return {
        available: true,
        configured: true,
        authorized: true,
        timezone: 'Europe/Berlin',
        events: [...calendarEvents].sort((a, b) => a.start.localeCompare(b.start)),
      };
    },
    createCalendarEvent: async (input = {}) => {
      await wait(250);
      const created = {
        id: `evt_preview_${Date.now()}`,
        summary: input.summary || 'Untitled event',
        start: input.start,
        end: input.end,
        location: input.location,
        description: input.description,
        htmlLink: 'https://calendar.google.com/',
        attendees: [],
      };
      calendarEvents.push(created);
      return created;
    },
    transcribeAudio: async () => {
      await wait(900);
      return 'Remind me to send the board deck to Maya on Thursday morning, and keep Friday afternoon free for the cabin.';
    },
    createAudioNote: async (payload = {}) => {
      await wait(1100);
      const transcript = 'Remind me to send the board deck to Maya on Thursday morning, and keep Friday afternoon free for the cabin.';
      const note = await api.createNote({
        title: 'Voice memo — board deck and cabin',
        content: `${transcript}\n\nAction items:\n- [ ] Send the board deck to Maya on Thursday morning\n- [ ] Keep Friday afternoon free for the cabin`,
        tags: ['work', 'personal'],
        source: 'audio',
      });
      note.audio_mime = payload.mime || 'audio/webm';
      note.audio_path = `${note.id}.webm`;
      note.duration_seconds = payload.durationSeconds || 18;
      return {note, transcript, structured: true};
    },
    captureClipboardNote: async () => {
      const note = await api.createNote({title: 'Clipboard note', content: 'Captured from the clipboard in preview mode.', source: 'clipboard'});
      return {ok: true, id: note.id, title: note.title};
    },
    getCoreState: async () => settings.core,
    restartCore: async () => {
      settings.core = {state: 'online', message: 'Preview core is online.', managed: true};
      return settings.core;
    },
    getOnboardingState: async () => settings.onboarding,
    testModel: async () => ({ok: true, reply: 'OK'}),
    completeOnboarding: async (payload = {}) => {
      settings = {...settings, onboarded: true, provider: payload.provider || settings.provider, model: payload.model || settings.model, hasApiKey: true};
      settings.onboarding = {needed: false, provider: settings.provider, model: settings.model, hasApiKey: true};
      return {settings, core: settings.core};
    },
    resetOnboarding: async () => {
      settings = {...settings, onboarded: false};
      settings.onboarding = {needed: true, provider: settings.provider, model: settings.model, hasApiKey: settings.hasApiKey};
      return settings.onboarding;
    },
    getCalendarFeeds: async () => [
      {id: 'feed_1', label: 'Personal', url: 'https://calendar.google.com/calendar/ical/preview/basic.ics'},
      {id: 'feed_2', label: 'School', url: 'https://calendar.google.com/calendar/ical/school/basic.ics'},
    ],
    addCalendarFeed: async (feed = {}) => ({id: `feed_${Date.now()}`, label: feed.label || 'Calendar', url: feed.url}),
    removeCalendarFeed: async () => ({ok: true}),
    getCanvas: async () => {
      await wait(220);
      return canvasData;
    },
    getCanvasAssignments: async (courseId, bucket = 'upcoming') => {
      await wait(200);
      const course = canvasData.courses.find((item) => item.id === courseId);
      return canvasAssignments
        .filter((item) => !course || item.courseName === course.name)
        .filter((item) => (bucket === 'past' ? item.submitted : !item.submitted));
    },
    connectCanvas: async () => canvasData,
    disconnectCanvas: async () => ({settings: {...settings, hasCanvasToken: false}, core: settings.core}),
    browserNavigate: async (raw) => {
      const value = String(raw || '');
      browser = {...browser, url: /^https?:/i.test(value) ? value : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`, title: value.includes('calendar') ? 'Google Calendar — Week' : 'JARVIS Browser', canGoBack: true};
      return browser;
    },
    browserBack: async () => browser,
    browserForward: async () => browser,
    browserReload: async () => browser,
    browserStop: async () => browser,
    browserSetBounds: async () => ({ok: true}),
    browserContext: async () => ({
      url: browser.url,
      title: browser.title,
      text: 'Google Calendar — Week of 10 November. Product review Monday 09:30. Board deck working session Tuesday 10:00. Design critique Tuesday 16:00. Dentist Wednesday 08:30. Quarterly planning Friday 14:00.',
    }),
    browserOpenExternal: async () => ({ok: true}),
    hide: async () => undefined,
    quit: async () => undefined,
    openExternal: async () => ({ok: true}),
    onChatEvent: (callback) => { chatListeners.add(callback); return () => chatListeners.delete(callback); },
    onUiEvent: (callback) => { uiListeners.add(callback); return () => uiListeners.delete(callback); },
  };

  window.jarvis = api;
})();
