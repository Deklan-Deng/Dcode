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

contextBridge.exposeInMainWorld('dshDesktop', {
  onStatus: (callback) => {
    ipcRenderer.on('dsh:status', (_event, text) => callback(text))
  },
  onFailure: (callback) => {
    ipcRenderer.on('dsh:failure', (_event, text) => callback(text))
  },
  quit: () => ipcRenderer.send('dsh:quit'),
  beginUpdate: () => ipcRenderer.send('dsh:update'),
})
