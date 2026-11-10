'use strict';

const {contextBridge, ipcRenderer} = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('jarvis', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testConnection: () => ipcRenderer.invoke('jarvis:status'),
  startChat: (payload) => ipcRenderer.invoke('chat:start', payload),
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),
  approve: (id, approved) => ipcRenderer.invoke('jarvis:approve', {id, approved}),
  remember: (content) => ipcRenderer.invoke('jarvis:remember', content),
  captureClipboard: () => ipcRenderer.invoke('app:capture-clipboard'),
  listConversations: () => ipcRenderer.invoke('jarvis:conversations'),
  getMessages: (conversationId) => ipcRenderer.invoke('jarvis:messages', conversationId),
  listNotes: (options) => ipcRenderer.invoke('notes:list', options),
  getNote: (id) => ipcRenderer.invoke('notes:get', id),
  createNote: (note) => ipcRenderer.invoke('notes:create', note),
  updateNote: (id, patch) => ipcRenderer.invoke('notes:update', {id, patch}),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  getCalendar: (days) => ipcRenderer.invoke('calendar:list', days),
  createCalendarEvent: (event) => ipcRenderer.invoke('calendar:create', event),
  transcribeAudio: (payload) => ipcRenderer.invoke('audio:transcribe', payload),
  createAudioNote: (payload) => ipcRenderer.invoke('audio:note', payload),
  captureClipboardNote: () => ipcRenderer.invoke('app:capture-clipboard-note'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onChatEvent: (callback) => subscribe('chat:event', callback),
  onUiEvent: (callback) => subscribe('ui:event', callback),
});
