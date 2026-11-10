'use strict';

const {contextBridge, ipcRenderer} = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('jarvis', {
  platform: process.platform,

  // Settings and lifecycle
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getCoreState: () => ipcRenderer.invoke('core:state'),
  restartCore: () => ipcRenderer.invoke('core:restart'),

  // First-run model onboarding
  getOnboardingState: () => ipcRenderer.invoke('onboarding:state'),
  testModel: (payload) => ipcRenderer.invoke('onboarding:test', payload),
  completeOnboarding: (payload) => ipcRenderer.invoke('onboarding:complete', payload),
  resetOnboarding: () => ipcRenderer.invoke('onboarding:reset'),

  // Chat, memory and notes
  testConnection: () => ipcRenderer.invoke('jarvis:status'),
  startChat: (payload) => ipcRenderer.invoke('chat:start', payload),
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
  approve: (id, approved) => ipcRenderer.invoke('jarvis:approve', {id, approved}),
  remember: (content) => ipcRenderer.invoke('jarvis:remember', content),
  captureClipboard: () => ipcRenderer.invoke('app:capture-clipboard'),
  captureClipboardNote: () => ipcRenderer.invoke('app:capture-clipboard-note'),
  listConversations: () => ipcRenderer.invoke('jarvis:conversations'),
  getMessages: (conversationId) => ipcRenderer.invoke('jarvis:messages', conversationId),
  listNotes: (options) => ipcRenderer.invoke('notes:list', options),
  getNote: (id) => ipcRenderer.invoke('notes:get', id),
  createNote: (note) => ipcRenderer.invoke('notes:create', note),
  updateNote: (id, patch) => ipcRenderer.invoke('notes:update', {id, patch}),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),

  // Calendar and Canvas
  getCalendar: (days) => ipcRenderer.invoke('calendar:list', days),
  createCalendarEvent: (event) => ipcRenderer.invoke('calendar:create', event),
  getCalendarFeeds: () => ipcRenderer.invoke('calendar:feeds'),
  addCalendarFeed: (feed) => ipcRenderer.invoke('calendar:add-feed', feed),
  removeCalendarFeed: (id) => ipcRenderer.invoke('calendar:remove-feed', id),
  getCanvas: () => ipcRenderer.invoke('canvas:summary'),
  getCanvasAssignments: (courseId, bucket) => ipcRenderer.invoke('canvas:assignments', {courseId, bucket}),
  connectCanvas: (payload) => ipcRenderer.invoke('canvas:connect', payload),
  disconnectCanvas: () => ipcRenderer.invoke('canvas:disconnect'),

  // Voice
  transcribeAudio: (payload) => ipcRenderer.invoke('audio:transcribe', payload),
  createAudioNote: (payload) => ipcRenderer.invoke('audio:note', payload),

  // Embedded browser
  browserNavigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  browserBack: () => ipcRenderer.invoke('browser:back'),
  browserForward: () => ipcRenderer.invoke('browser:forward'),
  browserReload: () => ipcRenderer.invoke('browser:reload'),
  browserStop: () => ipcRenderer.invoke('browser:stop'),
  browserSetBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
  browserContext: () => ipcRenderer.invoke('browser:context'),
  browserOpenExternal: () => ipcRenderer.invoke('browser:open-external'),

  // Shell
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onChatEvent: (callback) => subscribe('chat:event', callback),
  onUiEvent: (callback) => subscribe('ui:event', callback),
});
