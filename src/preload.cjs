/**
 * Preload for the splash and main windows: a minimal, context-isolated bridge.
 * The dsh Web GUI itself needs nothing from Electron; this bridge drives the
 * splash status line / quit button and lets the injected update badge start
 * the desktop shell's update flow.
 *
 * Kept as CommonJS: sandboxed preloads (webPreferences.sandbox = true) do not
 * run in an ESM context.
 * @module dcode/preload
 */

const { contextBridge, ipcRenderer } = require('electron')

// Channel callbacks run in the isolated world; a structured-clone failure here
// would otherwise surface as an untraceable "An object could not be cloned".
const subscribe = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => {
    try {
      callback(payload)
    } catch (error) {
      console.error(`[preload] ${channel} callback failed:`, String(error))
    }
  })
}

contextBridge.exposeInMainWorld('dshDesktop', {
  onStatus: (callback) => {
    ipcRenderer.on('dsh:status', (_event, text) => callback(text))
  },
  onFailure: (callback) => {
    ipcRenderer.on('dsh:failure', (_event, text) => callback(text))
  },
  quit: () => ipcRenderer.send('dsh:quit'),
  beginUpdate: () => ipcRenderer.send('dsh:update'),
  // Custom header bar bridge.
  headerAction: (name) => ipcRenderer.send('header:action', name),
  // Usage dashboard (settings) bridge.
  usageGet: () => ipcRenderer.invoke('usage:get'),
  // Terminal panel bridge (xterm.js <-> node-pty sessions in the main process).
  termOnTabs: subscribe('term:tabs'),
  termOnTab: subscribe('term:tab'),
  termOnTabClosed: subscribe('term:tab-closed'),
  termOnWorkspaces: subscribe('term:workspaces'),
  termOnData: subscribe('term:data'),
  termOnExit: subscribe('term:exit'),
  termNew: (payload) => ipcRenderer.send('term:new', payload),
  termActivate: (id) => ipcRenderer.send('term:activate', id),
  termCloseTab: (id) => ipcRenderer.send('term:close-tab', id),
  termInput: (data) => ipcRenderer.send('term:input', data),
  termResize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
  termOpenLink: (url) => ipcRenderer.send('term:open-link', url),
  termReady: () => ipcRenderer.send('term:ready'),
  termClose: () => ipcRenderer.send('term:close'),
  termDragStart: () => ipcRenderer.send('term:drag-start'),
  termDragEnd: () => ipcRenderer.send('term:drag-end'),
})
