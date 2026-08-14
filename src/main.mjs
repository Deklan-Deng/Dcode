/**
 * Electron main process: single-instance shell that boots the bundled dsh web
 * server, shows a splash while it starts, then hosts the Web GUI in one window.
 *
 * Self-update: the app watches ITS OWN version against the GitHub Releases of
 * the user's repository (update-config.json). A newer version shows a passive
 * "更新 vX.Y.Z" button next to the GUI's settings icon — nothing happens until
 * the user clicks, so running tasks are never interrupted.
 * @module dcode/main
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, WebContentsView } from 'electron'
// electron-updater is CommonJS; ESM named-export detection fails in the
// packaged loader, so default-import and destructure instead.
import updaterModule from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_BUILT_ARGS, startServer } from './server.mjs'
import { layoutTerminalPanel, setChromeHeight, setShortcutHandler, setSidebarWidth, toggleTerminalPanel } from './terminal.mjs'
import { checkForAppUpdate, ensureHarness, localAppVersion } from './updater.mjs'

const { autoUpdater } = updaterModule

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_NAME = 'Dcode'
/** Brand assets: app icon + menu-bar tray glyphs (build/). */
const ASSETS_DIR = path.join(__dirname, '..', 'build')
/** Height of the custom in-window menu bar (header chrome). */
const CHROME_H = 36

app.setName(APP_NAME)

// One app instance hosts one server; a second launch focuses the first window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let serverHandle = null
  let pendingServer = null
  let quitting = false
  let updating = false
  let splash = null
  let mainWindow = null
  let guiView = null
  let headerView = null
  let tray = null
  let updateTimer = null
  let lastUpdateVersion = null
  let lastReleaseUrl = ''
  let sidebarTimer = null
  let measuredSidebar = 0
  let isPackagedRun = false
  let harnessRuntimeDir = null

  const logDir = path.join(app.getPath('userData'), 'logs')
  const logFile = path.join(logDir, 'dsh.log')

  /** Route a status line to the splash (when alive), the log file, and stdout. */
  const log = (text) => {
    const line = `[${new Date().toISOString()}] ${text}\n`
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(logFile, line)
    } catch {
      // Logging must never take the app down.
    }
    if (splash !== null && !splash.isDestroyed()) {
      splash.webContents.send('dsh:status', text)
    }
    console.log(line.trimEnd())
  }

  const sendFailure = (message) => {
    if (splash !== null && !splash.isDestroyed()) {
      splash.webContents.send('dsh:failure', message)
    }
  }

  const createSplash = () => {
    splash = new BrowserWindow({
      width: 440,
      height: 300,
      resizable: false,
      frame: false,
      transparent: false,
      backgroundColor: '#0b0e14',
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    splash.loadFile(path.join(__dirname, 'splash.html'))
    splash.once('ready-to-show', () => splash.show())
    splash.on('closed', () => {
      splash = null
    })
  }

  /**
   * The badge script injected into the Web GUI: anchors a pill button to the
   * right of the settings trigger (the sidebar-foot `button[aria-haspopup="dialog"]`),
   * falls back to the window corner when the anchor cannot be found, and keeps
   * re-positioning while the GUI re-renders. Clicking asks the desktop shell
   * (preload bridge) to run the update.
   */
  const badgeScript = (version) => `(() => {
    const version = ${JSON.stringify(version)}
    if (window.__dshUpdateBadge !== undefined) {
      if (window.__dshUpdateBadge.dataset.version === version) return 'exists'
      window.__dshUpdateBadge.dataset.version = version
      window.__dshUpdateBadge.lastChild.textContent = version
      return 'exists'
    }
    const pickAnchor = () => {
      let best = null
      for (const el of document.querySelectorAll('button[aria-haspopup="dialog"]')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (r.left < 420 && r.top > window.innerHeight * 0.4) {
          if (best === null || r.left < best.left) best = el
        }
      }
      return best
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'dsh-update-badge'
    btn.dataset.version = version
    btn.style.cssText = [
      'position:fixed', 'z-index:2147483000', 'cursor:pointer',
      'display:inline-flex', 'align-items:center', 'gap:7px',
      'padding:6px 12px', 'border-radius:999px',
      'border:1px solid rgba(77,107,254,.6)',
      'background:#10162a', 'color:#a9bdff',
      'font-size:12px', 'font-weight:600', 'line-height:1',
      'box-shadow:0 2px 14px rgba(0,0,0,.45)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'white-space:nowrap',
    ].join(';')
    const dot = document.createElement('span')
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#4d6bfe;flex:none;'
    const label = document.createElement('span')
    label.textContent = version
    btn.append(dot)
    btn.append(document.createTextNode('更新 v'))
    btn.append(label)
    btn.title = '官方有新版本，点击更新并重启应用'
    let anchor = null
    const position = () => {
      const candidate = pickAnchor()
      if (candidate !== null) anchor = candidate
      if (anchor === null || !document.contains(anchor)) {
        btn.style.left = 'auto'
        btn.style.top = 'auto'
        btn.style.right = '18px'
        btn.style.bottom = '18px'
        btn.style.transform = 'none'
        return
      }
      const r = anchor.getBoundingClientRect()
      btn.style.right = 'auto'
      btn.style.bottom = 'auto'
      btn.style.left = Math.round(r.right + 10) + 'px'
      btn.style.top = Math.round(r.top + r.height / 2) + 'px'
      btn.style.transform = 'translateY(-50%)'
    }
    position()
    window.addEventListener('resize', position)
    setInterval(position, 3000)
    btn.addEventListener('click', () => {
      if (window.dshDesktop !== undefined) window.dshDesktop.beginUpdate()
    })
    btn.addEventListener('mouseenter', () => { btn.style.background = '#1a2444' })
    btn.addEventListener('mouseleave', () => { btn.style.background = '#10162a' })
    document.body.appendChild(btn)
    window.__dshUpdateBadge = btn
    return anchor === null ? 'mounted-corner' : 'mounted-settings'
  })()`

  /** Show the passive update pill next to the GUI's settings icon. */
  const showUpdateBadge = (version) => {
    if (mainWindow === null || mainWindow.isDestroyed() || guiView === null) return
    lastUpdateVersion = version
    guiView.webContents
      .executeJavaScript(badgeScript(version), true)
      .then((result) => log(`Update badge: ${String(result)} (v${version})`))
      .catch((error) => log(`Update badge injection failed: ${String(error)}`))
  }

  const createTray = () => {
    if (tray !== null || process.platform !== 'darwin') return
    const p1 = path.join(ASSETS_DIR, 'trayTemplate.png')
    const p2 = path.join(ASSETS_DIR, 'trayTemplate@2x.png')
    if (!fs.existsSync(p1)) return
    const image = nativeImage.createEmpty()
    image.addRepresentation({ scaleFactor: 1.0, buffer: fs.readFileSync(p1) })
    if (fs.existsSync(p2)) image.addRepresentation({ scaleFactor: 2.0, buffer: fs.readFileSync(p2) })
    image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setToolTip(`${APP_NAME} — DeepSeek Harness Desktop`)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '切换终端', click: () => toggleTerminalPanel(mainWindow, guiView) },
      {
        label: `打开 ${APP_NAME}`,
        click: () => {
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.focus()
          }
        },
      },
      { type: 'separator' },
      { label: `退出 ${APP_NAME}`, click: () => app.quit() },
    ]))
  }

  /** Keep the custom header chrome sized to the window. */
  const layoutChrome = () => {
    if (mainWindow === null || mainWindow.isDestroyed() || headerView === null) return
    const [width] = mainWindow.getContentSize()
    headerView.setBounds({ x: 0, y: 0, width, height: CHROME_H })
  }

  /**
   * Measure the GUI's left navigation sidebar so the terminal panel can sit
   * to its right without covering it. Best-effort: falls back to a default.
   */
  const measureSidebar = async () => {
    if (guiView === null || guiView.webContents.isDestroyed()) return
    try {
      const width = await guiView.webContents.executeJavaScript(
        `(() => {
          let best = 0
          for (const el of document.querySelectorAll('aside, nav, [class*="sidebar" i], [class*="Sidebar"], [class*="rail" i]')) {
            const r = el.getBoundingClientRect()
            if (r.width < 80 || r.width > 560 || r.height < 300) continue
            if (r.left < 8 && r.top < 80) best = Math.max(best, r.width)
          }
          return Math.round(best)
        })()`,
        true,
      )
      if (Number.isFinite(width) && width > 0 && Math.abs(width - measuredSidebar) > 8) {
        measuredSidebar = width
        log(`GUI sidebar width: ${width}px`)
        setSidebarWidth(width)
      }
    } catch {
      // Measurement is best-effort; the default sidebar width stands.
    }
  }

  const scheduleSidebarChecks = () => {
    if (sidebarTimer !== null) clearInterval(sidebarTimer)
    // The sidebar can collapse/expand, so keep the measurement fresh.
    sidebarTimer = setInterval(() => void measureSidebar(), 3000)
  }

  /** Header chrome actions (sent by header.html over header:action). */
  const runHeaderAction = (name) => {
    if (name === 'toggle-terminal') {
      toggleTerminalPanel(mainWindow, guiView)
    } else if (name === 'open-github') {
      void shell.openExternal('https://github.com/Deklan-Deng/Dcode')
    }
  }

  // With the native application menu removed, standard shortcuts must be
  // re-registered per view (before-input-event covers GUI, header, terminal).
  const installShortcuts = (webContents) => {
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const isMac = process.platform === 'darwin'
      const mod = isMac ? input.meta : input.control
      const key = input.key.toLowerCase()
      if (mod && key === 'q') {
        event.preventDefault()
        app.quit()
      } else if (mod && key === 'w') {
        event.preventDefault()
        if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.close()
      } else if (mod && key === 'm') {
        event.preventDefault()
        if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.minimize()
      } else if (isMac && mod && key === 'h') {
        event.preventDefault()
        app.hide()
      } else if (input.control && input.key === '`') {
        event.preventDefault()
        toggleTerminalPanel(mainWindow, guiView)
      }
    })
  }

  const createMainWindow = (url) => {
    mainWindow = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: APP_NAME,
      backgroundColor: '#0b0e14',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    })
    mainWindow.once('ready-to-show', () => mainWindow.show())
    // Safety net: the window's own webContents stays blank (the child views
    // carry the UI), so ready-to-show may never fire — never leave the window
    // hidden. The GUI's did-finish-load below also shows it.
    const showTimer = setTimeout(() => {
      if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show()
      }
    }, 3000)
    mainWindow.on('resize', () => {
      layoutChrome()
      layoutTerminalPanel()
      // Debounce: re-measure the sidebar after resizing settles.
      clearTimeout(measureSidebar.debounce)
      measureSidebar.debounce = setTimeout(() => void measureSidebar(), 250)
    })
    mainWindow.on('closed', () => {
      clearTimeout(showTimer)
      if (sidebarTimer !== null) clearInterval(sidebarTimer)
      sidebarTimer = null
      mainWindow = null
      guiView = null
      headerView = null
    })

    // Custom menu bar (top chrome): replaces the native application menu.
    headerView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    headerView.setBackgroundColor('#14161d')
    mainWindow.contentView.addChildView(headerView)
    headerView.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') console.log(`[header renderer] ${message}`)
    })
    installShortcuts(headerView.webContents)
    void headerView.webContents.loadFile(path.join(__dirname, 'header.html'))
    layoutChrome()

    // The GUI lives in a child view so the terminal panel can share the
    // window below it (Codex-style split instead of a separate window).
    guiView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    guiView.setBackgroundColor('#0b0e14')
    mainWindow.contentView.addChildView(guiView)
    {
      const [width, height] = mainWindow.getContentSize()
      guiView.setBounds({ x: 0, y: CHROME_H, width, height: height - CHROME_H })
    }
    installShortcuts(guiView.webContents)

    // Keep the GUI inside the app: same-origin navigations load in-window,
    // external http(s) links open in the default browser.
    const serverOrigin = new URL(url).origin
    guiView.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith('http://') || target.startsWith('https://')) {
        if (target.startsWith(serverOrigin)) return { action: 'allow' }
        void shell.openExternal(target)
      }
      return { action: 'deny' }
    })
    guiView.webContents.on('will-navigate', (event, target) => {
      if (!target.startsWith(serverOrigin)) {
        event.preventDefault()
        if (target.startsWith('http://') || target.startsWith('https://')) {
          void shell.openExternal(target)
        }
      }
    })

    guiView.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') log(`[renderer] ${message}`)
    })
    guiView.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
      log(`Main window failed to load ${validatedUrl} (${code}): ${description}`)
    })
    guiView.webContents.on('did-finish-load', () => {
      log('Main window loaded.')
      if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show()
      }
      if (splash !== null && !splash.isDestroyed()) splash.close()
      // A reload wipes injected DOM; restore the badge when an update is pending.
      if (lastUpdateVersion !== null) showUpdateBadge(lastUpdateVersion)
      void measureSidebar()
      scheduleSidebarChecks()
    })

    void guiView.webContents.loadURL(url)
  }

  const bootServer = async () => {
    log('Starting DeepSeek Harness (dsh web)…')
    pendingServer = startServer({
      log,
      logFile,
      // Packaged runs use the extracted snapshot + the pre-built CLI; dev
      // runs keep the source launcher over the project checkout.
      cwd: isPackagedRun ? harnessRuntimeDir : undefined,
      args: isPackagedRun ? HARNESS_BUILT_ARGS : undefined,
    })
    let handle
    try {
      handle = await pendingServer
    } catch (error) {
      pendingServer = null
      const message = error instanceof Error ? error.message : String(error)
      log(`Server failed: ${message}`)
      sendFailure(message)
      return
    }
    pendingServer = null
    serverHandle = handle
    if (quitting) {
      // Quit was requested while the server was still booting.
      await handle.stop()
      return
    }
    createMainWindow(handle.url)
    // Test hook: open the terminal panel right after the GUI loads.
    if (process.env.DSH_DESKTOP_OPEN_TERMINAL === '1') toggleTerminalPanel(mainWindow, guiView)
  }

  const stopServer = async () => {
    // A boot still in flight has no handle yet; wait for it, then stop it.
    if (pendingServer !== null) {
      try {
        serverHandle = await pendingServer
      } catch {
        serverHandle = null
      }
      pendingServer = null
    }
    const handle = serverHandle
    serverHandle = null
    if (handle !== undefined) {
      log('Stopping dsh server…')
      await handle.stop()
    }
  }

  /** Poll the app's own release feed; on a newer version show the passive badge. */
  const runUpdateCheck = async () => {
    if (updating || quitting) return
    // Test hook: force the badge without touching version state.
    if (process.env.DSH_DESKTOP_FORCE_UPDATE === '1') {
      showUpdateBadge('9.9.9-test')
      return
    }
    log('Checking for a newer desktop app version…')
    const result = await checkForAppUpdate({ onProgress: log })
    if (!result.configured) return
    if (result.error !== undefined) {
      log(`Update check failed: ${result.error}`)
      return
    }
    if (result.hasUpdate) {
      log(`New version available: ${result.latest} (current ${result.current})`)
      lastReleaseUrl = result.url
      showUpdateBadge(result.latest)
    } else {
      log(`App is up to date (${result.current}).`)
    }
  }

  /** Start the update watcher: one early check plus a check every 30 minutes. */
  const scheduleUpdateChecks = () => {
    updateTimer = setInterval(() => void runUpdateCheck(), 30 * 60_000)
    setTimeout(() => void runUpdateCheck(), 15_000)
  }

  /**
   * Download the platform package for the pending version via electron-updater.
   * Resolves when the installer is ready on disk; rejects on failure.
   */
  const downloadPackage = () => {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        autoUpdater.removeAllListeners('update-available')
        autoUpdater.removeAllListeners('update-not-available')
        autoUpdater.removeAllListeners('download-progress')
        autoUpdater.removeAllListeners('update-downloaded')
        autoUpdater.removeAllListeners('error')
      }
      autoUpdater.once('update-available', () => {
        log('Downloading the update package…')
        autoUpdater.downloadUpdate()
      })
      autoUpdater.once('update-not-available', () => {
        cleanup()
        reject(new Error('electron-updater reports no newer version for this platform.'))
      })
      autoUpdater.on('download-progress', (progress) => {
        log(`Downloading… ${Math.round(progress.percent)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s)`)
      })
      autoUpdater.once('update-downloaded', () => {
        cleanup()
        log('Update package downloaded.')
        resolve()
      })
      autoUpdater.once('error', (error) => {
        cleanup()
        reject(error)
      })
      autoUpdater.autoDownload = false
      autoUpdater.checkForUpdates()
    })
  }

  /**
   * User-initiated update, package-based:
   * - packaged app (dmg/exe from your GitHub release): download the matching
   *   platform package with progress on the splash, then quit and install.
   * - development run (`npm start`): there is no installed package to replace,
   *   so open the release page in the browser for a manual download.
   */
  const beginUpdate = async () => {
    if (updating || quitting) return
    updating = true
    log('Update started (user request)…')
    if (!app.isPackaged) {
      const target = lastReleaseUrl !== '' ? lastReleaseUrl : 'https://github.com/'
      log(`Development mode: opening release page ${target}`)
      void shell.openExternal(target)
      updating = false
      return
    }
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.close()
    if (splash === null || splash.isDestroyed()) createSplash()
    try {
      await downloadPackage()
      log('Installing the update…')
      await stopServer()
      autoUpdater.quitAndInstall(false, true)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`Update failed: ${message}`)
      await dialog.showMessageBox(splash, {
        type: 'error',
        title: '更新失败',
        message: '更新失败，应用将重启回当前状态',
        detail: message.slice(-4000),
        buttons: ['重启应用'],
      })
      app.relaunch()
      app.exit(0)
    }
  }

  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  ipcMain.on('dsh:quit', () => app.quit())
  ipcMain.on('dsh:update', () => void beginUpdate())

  app.whenReady().then(() => {
    // The app chrome is fully custom: the native application menu is removed
    // (it would otherwise show "Electron" in dev) and replaced by the in-window
    // header bar (header.html) plus per-view shortcut handling.
    Menu.setApplicationMenu(null)
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: localAppVersion(),
      copyright: 'MIT License — Dcode contributors',
      website: 'https://github.com/Deklan-Deng/Dcode',
    })
    setChromeHeight(CHROME_H)
    setShortcutHandler(installShortcuts)
    ipcMain.on('header:action', (_event, name) => runHeaderAction(String(name)))

    // Dev runs use Electron's generic dock icon; brand it with the fish mark.
    // Hand the dock a properly sized image (128pt @1x / 256 @2x): a raw 1024px
    // PNG renders at its natural size and looks oversized next to other apps.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const p128 = path.join(ASSETS_DIR, 'icon128.png')
      const p256 = path.join(ASSETS_DIR, 'icon256.png')
      if (fs.existsSync(p128)) {
        const dockImage = nativeImage.createEmpty()
        dockImage.addRepresentation({ scaleFactor: 1.0, buffer: fs.readFileSync(p128) })
        if (fs.existsSync(p256)) dockImage.addRepresentation({ scaleFactor: 2.0, buffer: fs.readFileSync(p256) })
        app.dock.setIcon(dockImage)
      }
    }
    createTray()
    createSplash()
    void (async () => {
      // Packaged runs resolve the harness snapshot out of the app bundle and
      // extract it into userData; dev runs use the project's harness/ checkout.
      isPackagedRun = app.isPackaged
      harnessRuntimeDir = isPackagedRun ? path.join(app.getPath('userData'), 'harness') : null
      log('Checking the bundled deepseek-harness…')
      const ready = await ensureHarness({
        onProgress: log,
        packaged: isPackagedRun,
        harnessDir: harnessRuntimeDir ?? undefined,
        snapshotPath: isPackagedRun ? path.join(process.resourcesPath, 'harness.tgz') : null,
        snapshotMetaPath: isPackagedRun ? path.join(process.resourcesPath, 'harness.meta.json') : null,
        version: localAppVersion(),
      })
      if (!ready) {
        sendFailure('Bundled harness bootstrap failed. See the log above.')
        return
      }
      await bootServer()
      if (serverHandle !== null) scheduleUpdateChecks()
    })()
  })

  // The server lives and dies with the app: closing the window quits.
  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    if (updateTimer !== null) clearInterval(updateTimer)
    void stopServer().finally(() => app.quit())
  })
}
