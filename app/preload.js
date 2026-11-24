'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

// The renderer gets these calls and nothing else. Every network request and
// file write happens in the main process.
contextBridge.exposeInMainWorld('switcher', {
  init: () => call('app:init'),
  ready: () => call('app:ready'),
  version: () => call('app:version'),
  status: () => call('bridge:status'),
  refresh: () => call('bridge:refresh'),
  install: () => call('bridge:install'),
  openRepo: () => call('repo:open'),

  library: () => call('library:list'),
  // { library, selection, reset }: re-read on focus; reset is the ref of a stale selection.
  refreshLibrary: () => call('library:refresh'),
  scene: ref => call('library:scene', String(ref)),
  // Raw skin.json / scene.svg of a library skin and the validator's verdict.
  code: ref => call('library:code', String(ref)),
  // Delete a non-official skin from the library (main resets the theme if it was active).
  deleteSkin: ref => call('library:delete', String(ref)),
  // Apply a skin with the draft settings the window holds for it.
  select: (ref, draft) => call('theme:select', String(ref), draft ?? null),
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
  claimHandle: name => call('auth:claimHandle', String(name)),

  mySkins: () => call('upload:mine'),
  pickFolder: () => call('upload:pickFolder'),
  checkLibrary: ref => call('upload:checkLibrary', String(ref)),
  upload: () => call('upload:send'),
  deleteMine: slug => call('upload:delete', String(slug)),
})
