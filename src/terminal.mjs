/**
 * Bottom terminal panel inside the main window (Codex-style):
 *
 * The main window's contentView hosts two WebContentsViews:
 *   - the dsh Web GUI on top (owned by main.mjs),
 *   - the terminal panel at the bottom (owned here).
 *
 * The panel hosts terminal.html (xterm.js) driven by a real PTY (node-pty)
 * through the preload bridge (term:* IPC). The header bar doubles as a drag
 * handle: dragging it resizes the panel; Ctrl+` / menu / tray toggle it.
 * @module dcode/terminal
 */

import { ipcMain, screen, WebContentsView } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ptyModule from 'node-pty'

const { spawn } = ptyModule

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_HEIGHT = 250
const MIN_HEIGHT = 120

let mainWindow = null
let guiView = null
let terminalView = null
let ptyHandle = null
let termReady = false
let pendingChunks = []
let panelHeight = DEFAULT_HEIGHT
let dragging = false
let dragTimer = null
let ipcRegistered = false

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi)

/** The shell to run inside the terminal (user's default on unix, PowerShell on Windows). */
const pickShell = () => {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] }
  return { file: process.env.SHELL || '/bin/zsh', args: [] }
}

/** Lay the two views out: GUI on top, terminal panel at the bottom. */
export function layoutTerminalPanel() {
  if (mainWindow === null || mainWindow.isDestroyed() || guiView === null) return
  const [width, height] = mainWindow.getContentSize()
  if (terminalView === null) {
    // No panel: the GUI takes the whole window.
    guiView.setBounds({ x: 0, y: 0, width, height })
    return
  }
  const panel = clamp(panelHeight, MIN_HEIGHT, Math.floor(height * 0.75))
  guiView.setBounds({ x: 0, y: 0, width, height: height - panel })
  terminalView.setBounds({ x: 0, y: height - panel, width, height: panel })
}

const killPty = () => {
  if (ptyHandle !== null) {
    try {
      ptyHandle.kill()
    } catch {
      // Already dead is fine.
    }
    ptyHandle = null
  }
}

const spawnPty = () => {
  try {
    const { file, args } = pickShell()
    ptyHandle = spawn(file, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    })
  } catch (error) {
    pendingChunks.push(`终端启动失败: ${error instanceof Error ? error.message : String(error)}\r\n`)
    return
  }
  console.log(`Terminal pty started: ${pickShell().file}`)
  ptyHandle.onData((data) => {
    if (termReady && terminalView !== null) {
      terminalView.webContents.send('term:data', data)
    } else {
      pendingChunks.push(data)
      const buffered = pendingChunks.join('').length
      if (buffered > 64 * 1024) pendingChunks = [pendingChunks.join('').slice(-32 * 1024)]
    }
  })
  ptyHandle.onExit(({ exitCode }) => {
    ptyHandle = null
    if (terminalView !== null) terminalView.webContents.send('term:exit', exitCode)
  })
}

const registerIpc = () => {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.on('term:ready', (event) => {
    termReady = true
    console.log('Terminal renderer attached (xterm ready).')
    if (pendingChunks.length > 0) {
      const buffered = pendingChunks.join('')
      pendingChunks = []
      event.sender.send('term:data', buffered)
    }
  })
  ipcMain.on('term:input', (_event, data) => {
    if (ptyHandle !== null) ptyHandle.write(String(data))
  })
  ipcMain.on('term:resize', (_event, cols, rows) => {
    if (ptyHandle === null) return
    try {
      ptyHandle.resize(Math.max(2, Number(cols)), Math.max(1, Number(rows)))
    } catch {
      // A resize racing the exit must never take the app down.
    }
  })
  ipcMain.on('term:close', () => closeTerminalPanel())
  ipcMain.on('term:drag-start', () => {
    dragging = true
    if (dragTimer === null) {
      dragTimer = setInterval(() => {
        if (!dragging || mainWindow === null || mainWindow.isDestroyed()) return
        const bounds = mainWindow.getContentBounds()
        panelHeight = clamp(
          bounds.y + bounds.height - screen.getCursorScreenPoint().y,
          MIN_HEIGHT,
          Math.floor(bounds.height * 0.75),
        )
        layoutTerminalPanel()
      }, 30)
    }
  })
  ipcMain.on('term:drag-end', () => {
    dragging = false
  })
}

/** Open the bottom terminal panel (no-op when it is already open). */
export function openTerminalPanel(win, gui) {
  mainWindow = win
  guiView = gui
  if (terminalView !== null) {
    terminalView.webContents.focus()
    return
  }
  registerIpc()
  termReady = false
  pendingChunks = []
  terminalView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  terminalView.setBackgroundColor('#0b0e14')
  if (typeof terminalView.setBorderRadius === 'function') {
    terminalView.setBorderRadius(10)
  }
  mainWindow.contentView.addChildView(terminalView)
  terminalView.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') console.log(`[terminal renderer] ${message}`)
  })
  terminalView.webContents.on('did-finish-load', () => {
    console.log('Terminal panel loaded.')
  })
  void terminalView.webContents.loadFile(path.join(__dirname, 'terminal.html'))
  spawnPty()
  layoutTerminalPanel()
  terminalView.webContents.focus()
}

/** Close the terminal panel, killing the shell with it. */
export function closeTerminalPanel() {
  if (terminalView === null) return
  killPty()
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(terminalView)
  }
  terminalView = null
  termReady = false
  pendingChunks = []
  layoutTerminalPanel()
  if (guiView !== null) guiView.webContents.focus()
}

/** Toggle the bottom terminal panel. */
export function toggleTerminalPanel(win, gui) {
  if (terminalView !== null) closeTerminalPanel()
  else openTerminalPanel(win, gui)
}
