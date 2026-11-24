'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

// The renderer gets these calls and nothing else. Every network request and
// file write happens in the main process.
contextBridge.exposeInMainWorld('switcher', {
  init: () => call('app:init'),
  ready: () => call('app:ready'),
  status: () => call('bridge:status'),
  refresh: () => call('bridge:refresh'),
  install: () => call('bridge:install'),
  openRepo: () => call('repo:open'),

  library: () => call('library:list'),
  scene: ref => call('library:scene', String(ref)),
  select: ref => call('theme:select', String(ref)),
  setSettings: (ref, raw) => call('settings:set', String(ref), raw),
  resetSettings: ref => call('settings:reset', String(ref)),
  flushSettings: () => call('settings:flush'),
  saveTuned: (ref, opts) => call('library:saveTuned', String(ref), opts),

  galleryList: opts => call('gallery:list', opts),
  galleryDetail: (author, slug) => call('gallery:detail', String(author), String(slug)),
  gallerySave: (author, slug) => call('gallery:save', String(author), String(slug)),
  galleryReport: (author, slug) => call('gallery:report', String(author), String(slug)),

  authState: () => call('auth:state'),
  authStart: () => call('auth:start'),
  authWait: () => call('auth:wait'),
  authCancel: () => call('auth:cancel'),
  signOut: () => call('auth:signOut'),
  openDevicePage: () => call('auth:openDevicePage'),

  mySkins: () => call('upload:mine'),
  pickFolder: () => call('upload:pickFolder'),
  checkLibrary: ref => call('upload:checkLibrary', String(ref)),
  upload: () => call('upload:send'),
  deleteMine: slug => call('upload:delete', String(slug)),
})
