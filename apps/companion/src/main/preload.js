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
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onChatEvent: (callback) => subscribe('chat:event', callback),
  onUiEvent: (callback) => subscribe('ui:event', callback),
});
