/* Terminal panel init: xterm + fit addon + preload bridge wiring.
 * The header bar is a drag handle that resizes the panel (via IPC). */
(function () {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#0b0e14',
      foreground: '#c9d4e3',
      cursor: '#4d6bfe',
      selectionBackground: 'rgba(77, 107, 254, 0.35)',
    },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(document.getElementById('term'))
  fit.fit()

  const syncSize = () => {
    try {
      fit.fit()
      window.dshDesktop.termResize(term.cols, term.rows)
    } catch {
      // Resize failures are cosmetic; never break the terminal.
    }
  }
  window.addEventListener('resize', syncSize)
  term.onData((data) => window.dshDesktop.termInput(data))
  window.dshDesktop.termOnData((data) => term.write(data))
  window.dshDesktop.termOnExit((code) => {
    const bar = document.getElementById('exitbar')
    bar.style.display = 'block'
    bar.textContent = '进程已退出 (code ' + code + ') — 点击 ✕ 关闭面板'
  })

  // Drag handle: resize the panel vertically while the header is pressed.
  const header = document.getElementById('header')
  header.addEventListener('mousedown', (event) => {
    if (event.target.id === 'close') return
    window.dshDesktop.termDragStart()
    event.preventDefault()
  })
  window.addEventListener('mouseup', () => window.dshDesktop.termDragEnd())
  document.getElementById('close').addEventListener('click', () => window.dshDesktop.termClose())

  window.dshDesktop.termReady()
  syncSize()
  term.focus()
})()
