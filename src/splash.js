/* Splash screen: a single status line driven by dsh:status messages. */
(function () {
  const statusEl = document.getElementById('status')
  const errorEl = document.getElementById('error')
  const quitEl = document.getElementById('quit')

  window.dshDesktop.onStatus((text) => {
    statusEl.textContent = text
  })
  window.dshDesktop.onFailure((text) => {
    statusEl.textContent = 'Failed to start DeepSeek Harness.'
    errorEl.textContent = text
    errorEl.style.display = 'block'
    quitEl.style.display = 'block'
  })
  quitEl.addEventListener('click', () => window.dshDesktop.quit())
})()
