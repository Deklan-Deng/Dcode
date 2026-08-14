/**
 * Bottom terminal panel inside the main window (Codex/VS Code-style):
 *
 * The main window's contentView hosts two WebContentsViews: the dsh Web GUI on
 * top (owned by main.mjs) and this terminal panel at the bottom. The panel
 * renders terminal.html (xterm.js) and holds MULTIPLE shell sessions — one per
 * tab — each backed by a real PTY (node-pty) in the main process. Tabs are
 * created/closed from the renderer; per-tab data is routed over term:* IPC.
 *
 * The header bar doubles as a drag handle (resizes the panel); Ctrl+` / menu /
 * tray toggle the whole panel.
 * @module dcode/terminal
 */

import { ipcMain, screen, shell, WebContentsView } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ptyModule from 'node-pty'

const { spawn } = ptyModule

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_HEIGHT = 250
const MIN_HEIGHT = 120
const BUFFER_LIMIT = 64 * 1024

const SHELL_FILES = { zsh: '/bin/zsh', bash: '/bin/bash', sh: '/bin/sh' }

let mainWindow = null
let guiView = null
let terminalView = null
let sessions = new Map() // id -> { id, pty, name, baseName, buffer, exited, exitCode }
let nextSessionId = 1
let activeId = null
let termReady = false
let panelHeight = DEFAULT_HEIGHT
let dragging = false
let dragTimer = null
let ipcRegistered = false
/** Height of the custom header chrome above the GUI (set by main.mjs). */
let chromeHeight = 0
/** Shortcut installer shared by main.mjs (applied to this panel's webContents). */
let shortcutHandler = null

export function setChromeHeight(height) {
  chromeHeight = Math.max(0, Number(height) || 0)
  layoutTerminalPanel()
}

export function setShortcutHandler(handler) {
  shortcutHandler = typeof handler === 'function' ? handler : null
}

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi)

const pickShell = (kind) => {
  if (process.platform === 'win32') return 'powershell.exe'
  if (kind === 'default') return process.env.SHELL || '/bin/zsh'
  return SHELL_FILES[String(kind)] || process.env.SHELL || '/bin/zsh'
}

/** Workspaces known to dsh (~/.dsh/storages/workspace.json), newest first. */
const readWorkspaces = () => {
  try {
    const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const tables = data.tables?.workspaces ?? {}
    return Object.values(tables)
      .map((workspace) => {
        const dir = String(workspace.path ?? '')
        return {
          path: dir,
          title: String(workspace.title ?? path.basename(dir) ?? dir),
          updatedAt: String(workspace.updatedAt ?? ''),
        }
      })
      .filter((workspace) => workspace.path !== '' && fs.existsSync(workspace.path))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  } catch {
    return []
  }
}

/** Where new terminals open: the most recently used dsh workspace, else home. */
const defaultCwd = () => {
  const newest = readWorkspaces()[0]
  return newest !== undefined ? newest.path : os.homedir()
}

/** Lay the views out: header chrome (main.mjs) on top, GUI below it, panel at the bottom. */
export function layoutTerminalPanel() {
  if (mainWindow === null || mainWindow.isDestroyed() || guiView === null) return
  const [width, height] = mainWindow.getContentSize()
  if (terminalView === null) {
    guiView.setBounds({ x: 0, y: chromeHeight, width, height: height - chromeHeight })
    return
  }
  const panel = clamp(panelHeight, MIN_HEIGHT, Math.floor(height * 0.75))
  guiView.setBounds({ x: 0, y: chromeHeight, width, height: height - chromeHeight - panel })
  terminalView.setBounds({ x: 0, y: height - panel, width, height: panel })
}

// ---------------------------------------------------------------------------
// Shell sessions (one PTY per tab)
// ---------------------------------------------------------------------------

const sendToPanel = (channel, payload) => {
  if (terminalView !== null && !terminalView.webContents.isDestroyed()) {
    terminalView.webContents.send(channel, payload)
  }
}

/** VS Code-style tab name: "zsh", then "zsh (2)", "zsh (3)", … */
const sessionNameFor = (file) => {
  const base = path.basename(file)
  const same = [...sessions.values()].filter((s) => s.baseName === base).length
  return same === 0 ? base : `${base} (${same + 1})`
}

function spawnSession(kind = 'default', cwd) {
  const file = pickShell(kind)
  let sessionCwd = defaultCwd()
  if (cwd === '~') sessionCwd = os.homedir()
  else if (typeof cwd === 'string' && cwd !== '' && fs.existsSync(cwd)) sessionCwd = cwd
  const session = {
    id: String(nextSessionId++),
    pty: null,
    name: sessionNameFor(file),
    baseName: path.basename(file),
    buffer: [],
    exited: false,
    exitCode: null,
  }
  sessions.set(session.id, session)
  try {
    session.pty = spawn(file, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: sessionCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
  } catch (error) {
    session.buffer.push(`终端启动失败: ${error instanceof Error ? error.message : String(error)}\r\n`)
    session.exited = true
  }
  if (session.pty !== null) {
    session.pty.onData((data) => {
      if (process.env.DSH_DESKTOP_TERM_TEST === '1') {
        console.log(`[term-data #${session.id}]`, JSON.stringify(String(data).slice(0, 80)))
      }
      if (termReady) {
        sendToPanel('term:data', { id: session.id, data })
      } else {
        session.buffer.push(data)
        const buffered = session.buffer.join('').length
        if (buffered > BUFFER_LIMIT) session.buffer = [session.buffer.join('').slice(-BUFFER_LIMIT / 2)]
      }
    })
    session.pty.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      sendToPanel('term:exit', { id: session.id, code: exitCode })
    })
  }
  if (activeId === null) activeId = session.id
  if (termReady) sendToPanel('term:tab', { id: session.id, name: session.name })
  return session
}

const killSession = (id) => {
  const session = sessions.get(id)
  if (session === undefined) return
  if (session.pty !== null) {
    try {
      session.pty.kill()
    } catch {
      // Already dead is fine.
    }
  }
  sessions.delete(id)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const registerIpc = () => {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.on('term:ready', (event) => {
    termReady = true
    console.log('Terminal renderer attached (xterm ready).')
    event.sender.send(
      'term:tabs',
      [...sessions.values()].map((s) => ({ id: s.id, name: s.name, exited: s.exited })),
    )
    event.sender.send('term:workspaces', readWorkspaces())
    for (const session of sessions.values()) {
      if (session.buffer.length > 0) {
        const buffered = session.buffer.join('')
        session.buffer = []
        event.sender.send('term:data', { id: session.id, data: buffered })
      }
    }
  })
  ipcMain.on('term:new', (_event, payload) => {
    const kind = typeof payload === 'string' ? payload : payload?.kind
    const cwd = typeof payload === 'object' && payload !== null ? payload.cwd : undefined
    spawnSession(kind === undefined ? 'default' : String(kind), cwd)
  })
  ipcMain.on('term:activate', (_event, id) => {
    if (sessions.has(String(id))) activeId = String(id)
  })
  ipcMain.on('term:close-tab', (_event, id) => {
    killSession(String(id))
    sendToPanel('term:tab-closed', { id: String(id) })
    // The last tab closing takes the whole panel down with it.
    if (sessions.size === 0) closeTerminalPanel()
  })
  ipcMain.on('term:input', (_event, data) => {
    const session = sessions.get(activeId)
    if (session !== undefined && session.pty !== null) session.pty.write(String(data))
  })
  ipcMain.on('term:resize', (_event, cols, rows) => {
    const session = sessions.get(activeId)
    if (session === undefined || session.pty === null) return
    try {
      session.pty.resize(Math.max(2, Number(cols)), Math.max(1, Number(rows)))
    } catch {
      // A resize racing the exit must never take the app down.
    }
  })
  ipcMain.on('term:open-link', (_event, url) => {
    const target = String(url)
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
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

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

/** Open the bottom terminal panel (no-op when it is already open). */
export function openTerminalPanel(win, gui) {
  mainWindow = win
  guiView = gui
  console.log('[terminal] openTerminalPanel called, view exists:', terminalView !== null)
  if (terminalView !== null) {
    terminalView.webContents.focus()
    return
  }
  registerIpc()
  termReady = false
  if (sessions.size === 0) spawnSession('default')
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
  if (shortcutHandler !== null) shortcutHandler(terminalView.webContents)
  terminalView.webContents.on('console-message', ({ level, message }) => {
    if (level === 'error') console.log(`[terminal renderer] ${message}`)
  })
  terminalView.webContents.on('did-finish-load', () => {
    console.log('Terminal panel loaded.')
  })
  void terminalView.webContents.loadFile(path.join(__dirname, 'terminal.html'))
  layoutTerminalPanel()
  terminalView.webContents.focus()

  // Test hook: click "+", run a command in the second tab, then close every
  // tab through the real × UI — the last one must auto-close the panel.
  if (process.env.DSH_DESKTOP_TERM_TEST === '1') {
    setTimeout(() => {
      void terminalView.webContents.executeJavaScript(
        "document.getElementById('newtab').click()",
      )
      setTimeout(() => {
        const session = sessions.get(activeId)
        if (session !== undefined && session.pty !== null) {
          session.pty.write('echo SECOND_TAB_OK && exit\r')
        }
      }, 1200)
      setTimeout(() => {
        void terminalView.webContents.executeJavaScript(
          "document.querySelectorAll('.tab .close').forEach((el) => el.click())",
        )
      }, 4500)
    }, 3000)
  }
}

/** Close the terminal panel, killing every shell session with it. */
export function closeTerminalPanel() {
  console.log('[terminal] closeTerminalPanel called, view exists:', terminalView !== null)
  if (terminalView === null) return
  for (const id of [...sessions.keys()]) killSession(id)
  activeId = null
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(terminalView)
  }
  // Deterministically tear the renderer down (GC alone is not prompt enough).
  try {
    terminalView.webContents.close()
  } catch {
    // Older Electron builds reject close() on views; GC handles it then.
  }
  terminalView = null
  termReady = false
  layoutTerminalPanel()
  if (guiView !== null) guiView.webContents.focus()
}

/** Toggle the bottom terminal panel. */
export function toggleTerminalPanel(win, gui) {
  if (terminalView !== null) closeTerminalPanel()
  else openTerminalPanel(win, gui)
}
