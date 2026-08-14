/* Terminal panel renderer: VS Code-style multi-tab terminal.
 * One xterm instance per shell session (tab); PTYs live in the main process
 * and are addressed over the term:* preload bridge. */
(function () {
  window.addEventListener('error', (event) => {
    console.error('PAGE ERROR:', event.message, event.error && event.error.stack)
  })
  window.addEventListener('unhandledrejection', (event) => {
    console.error('PAGE REJECTION:', String(event.reason))
  })

  const THEME = {
    background: '#0b0e14',
    foreground: '#c9d4e3',
    cursor: '#4d6bfe',
    selectionBackground: 'rgba(77, 107, 254, 0.35)',
  }
  const SHELL_KINDS = [
    { label: '默认 shell', value: 'default' },
    { label: 'zsh', value: 'zsh' },
    { label: 'bash', value: 'bash' },
    { label: 'sh', value: 'sh' },
  ]

  const tabs = new Map() // id -> { id, name, term, fit, search, pane, btn, label, exited }
  let activeId = null
  let workspaces = [] // [{ path, title }] from ~/.dsh, newest first

  const termHost = document.getElementById('term')
  const tabsEl = document.getElementById('tabs')
  const searchbar = document.getElementById('searchbar')
  const searchInput = document.getElementById('search-input')

  // -------------------------------------------------------------------------
  // Menus (dropdown + context menu)
  // -------------------------------------------------------------------------
  function openMenu(anchor, items, x, y) {
    closeMenus()
    const menu = document.createElement('div')
    menu.className = 'menu'
    for (const item of items) {
      if (item === 'sep') {
        const sep = document.createElement('div')
        sep.className = 'sep'
        menu.appendChild(sep)
        continue
      }
      const el = document.createElement('div')
      el.className = 'item' + (item.disabled ? ' disabled' : '')
      el.textContent = item.label
      if (!item.disabled) {
        el.addEventListener('click', () => {
          closeMenus()
          item.action()
        })
      }
      menu.appendChild(el)
    }
    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
  }

  function closeMenus() {
    for (const el of document.querySelectorAll('.menu')) el.remove()
  }
  document.addEventListener('mousedown', (event) => {
    if (!event.target.closest('.menu')) closeMenus()
  })

  const shellButton = document.getElementById('shellmenu')
  const shellMenuItems = () => [
    ...SHELL_KINDS.map((kind) => ({
      label: kind.label,
      action: () => window.dshDesktop.termNew({ kind: kind.value }),
    })),
    ...(workspaces.length > 0
      ? [
          'sep',
          ...workspaces.map((workspace) => ({
            label: `在 “${workspace.title}” 打开`,
            action: () => window.dshDesktop.termNew({ kind: 'default', cwd: workspace.path }),
          })),
        ]
      : []),
    'sep',
    {
      label: '在个人目录打开',
      action: () => window.dshDesktop.termNew({ kind: 'default', cwd: '~' }),
    },
  ]
  shellButton.addEventListener('click', () => {
    const rect = shellButton.getBoundingClientRect()
    openMenu(shellButton, shellMenuItems(), rect.left, rect.bottom + 4)
  })

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------
  function makeTerminal() {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 8000,
      theme: THEME,
    })
    const fit = new FitAddon.FitAddon()
    const search = new SearchAddon.SearchAddon()
    const links = new WebLinksAddon.WebLinksAddon((_event, uri) => {
      window.dshDesktop.termOpenLink(uri)
    })
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(links)
    return { term, fit, search }
  }

  function writeExitMessage(entry, code) {
    entry.term.write('\r\n\x1b[38;5;210m[进程已退出 (code ' + code + ')]\x1b[0m\r\n')
    entry.label.textContent = entry.name + ' · 已退出'
  }

  function createTab(id, name, exited) {
    if (tabs.has(id)) return tabs.get(id)

    const pane = document.createElement('div')
    pane.className = 'pane'
    pane.style.display = 'none'
    termHost.appendChild(pane)

    const t = makeTerminal()
    t.term.open(pane)
    t.term.onData((data) => window.dshDesktop.termInput(data))

    pane.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      const hasSelection = t.term.hasSelection()
      openMenu(
        pane,
        [
          {
            label: '复制',
            disabled: !hasSelection,
            action: () => {
              const text = t.term.getSelection()
              if (text) navigator.clipboard.writeText(text).catch(() => {})
            },
          },
          {
            label: '粘贴',
            action: () => {
              navigator.clipboard.readText().then((text) => t.term.paste(text)).catch(() => {})
            },
          },
          'sep',
          { label: '全选', action: () => t.term.selectAll() },
          { label: '清除终端', action: () => t.term.clear() },
        ],
        event.clientX,
        event.clientY,
      )
    })

    const btn = document.createElement('div')
    btn.className = 'tab'
    btn.dataset.id = id
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = name
    const close = document.createElement('span')
    close.className = 'close'
    close.textContent = '×'
    close.title = '关闭终端'
    btn.append(label, close)
    btn.addEventListener('click', (event) => {
      if (event.target.classList.contains('close')) {
        window.dshDesktop.termCloseTab(id)
      } else {
        activate(id)
      }
    })
    tabsEl.appendChild(btn)

    const entry = { id, name, ...t, pane, btn, label, exited: !!exited }
    tabs.set(id, entry)
    if (exited) writeExitMessage(entry, '—')
    if (activeId === null) activate(id)
    return entry
  }

  function activate(id) {
    const entry = tabs.get(id)
    if (entry === undefined) return
    activeId = id
    for (const [tid, t] of tabs) {
      t.pane.style.display = tid === id ? '' : 'none'
      t.btn.classList.toggle('active', tid === id)
    }
    try {
      entry.fit.fit()
      window.dshDesktop.termResize(entry.term.cols, entry.term.rows)
    } catch {
      // Resize failures are cosmetic.
    }
    window.dshDesktop.termActivate(id)
    entry.term.focus()
  }

  function removeTab(id) {
    const entry = tabs.get(id)
    if (entry === undefined) return
    entry.pane.remove()
    entry.btn.remove()
    tabs.delete(id)
    if (activeId === id) {
      const remaining = [...tabs.keys()]
      activeId = null
      if (remaining.length > 0) activate(remaining[0])
    }
  }

  function fitActive() {
    const entry = tabs.get(activeId)
    if (entry === undefined) return
    try {
      entry.fit.fit()
      window.dshDesktop.termResize(entry.term.cols, entry.term.rows)
    } catch {
      // Resize failures are cosmetic.
    }
  }

  window.addEventListener('resize', fitActive)

  // -------------------------------------------------------------------------
  // Search bar
  // -------------------------------------------------------------------------
  const doSearch = (forward) => {
    const entry = tabs.get(activeId)
    if (entry === undefined) return
    const query = searchInput.value
    const found = forward
      ? entry.search.findNext(query, { caseSensitive: false })
      : entry.search.findPrevious(query, { caseSensitive: false })
    searchInput.style.borderColor = found || query === '' ? '#2a3446' : '#b3455b'
  }
  const openSearch = () => {
    searchbar.style.display = 'flex'
    searchInput.focus()
    searchInput.select()
  }
  const closeSearch = () => {
    searchbar.style.display = 'none'
    const entry = tabs.get(activeId)
    if (entry !== undefined && typeof entry.search.clearDecorations === 'function') {
      entry.search.clearDecorations()
    }
  }
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doSearch(!event.shiftKey)
    if (event.key === 'Escape') closeSearch()
  })
  document.getElementById('search-prev').addEventListener('click', () => doSearch(false))
  document.getElementById('search-next').addEventListener('click', () => doSearch(true))
  document.getElementById('search-close').addEventListener('click', closeSearch)

  // -------------------------------------------------------------------------
  // Shortcuts + header controls
  // -------------------------------------------------------------------------
  document.getElementById('newtab').addEventListener('click', () => window.dshDesktop.termNew({ kind: 'default' }))
  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if ((event.metaKey || event.ctrlKey) && key === 't') {
      event.preventDefault()
      window.dshDesktop.termNew({ kind: 'default' })
    }
    if ((event.metaKey || event.ctrlKey) && key === 'f') {
      event.preventDefault()
      openSearch()
    }
  })

  // Drag handle: resize the panel from the empty header area only.
  const header = document.getElementById('header')
  header.addEventListener('mousedown', (event) => {
    if (event.target.closest('#tabs, #controls, #searchbar')) return
    window.dshDesktop.termDragStart()
    event.preventDefault()
  })
  window.addEventListener('mouseup', () => window.dshDesktop.termDragEnd())

  // -------------------------------------------------------------------------
  // Bridge
  // -------------------------------------------------------------------------
  window.dshDesktop.termOnTabs((list) => {
    for (const item of list) createTab(item.id, item.name, item.exited)
  })
  // Note: block bodies only — contextBridge clones callback return values,
  // and createTab returns a live xterm object that cannot be cloned.
  window.dshDesktop.termOnTab(({ id, name }) => {
    createTab(id, name, false)
    // A newly spawned session is the one the user just asked for: switch to it
    // (VS Code / Codex behavior). Without this, createTab only auto-activates
    // the FIRST tab (activeId === null), so every later "+" would add a hidden
    // pane whose name sits in the tab strip while the old terminal keeps focus.
    activate(id)
  })
  window.dshDesktop.termOnTabClosed(({ id }) => {
    removeTab(id)
  })
  window.dshDesktop.termOnWorkspaces((list) => {
    workspaces = Array.isArray(list) ? list : []
  })
  window.dshDesktop.termOnData(({ id, data }) => {
    const entry = tabs.get(id)
    if (entry !== undefined) entry.term.write(data)
  })
  window.dshDesktop.termOnExit(({ id, code }) => {
    const entry = tabs.get(id)
    if (entry !== undefined) {
      entry.exited = true
      writeExitMessage(entry, code)
    }
  })
  window.dshDesktop.termReady()
  fitActive()
})()
