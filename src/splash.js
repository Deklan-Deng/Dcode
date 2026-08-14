/* Splash screen: step checklist driven by dsh:step messages. */
(function () {
  const statusEl = document.getElementById('status')
  const errorEl = document.getElementById('error')
  const quitEl = document.getElementById('quit')
  const stepsEl = document.getElementById('steps')
  const stepRows = new Map()

  window.dshDesktop.onStatus((text) => {
    statusEl.textContent = text
  })
  window.dshDesktop.onStep(({ id, label, state, detail }) => {
    let row = stepRows.get(id)
    if (row === undefined) {
      row = document.createElement('div')
      row.className = 'step'
      const stateEl = document.createElement('span')
      stateEl.className = 'state'
      const labelEl = document.createElement('span')
      labelEl.className = 'label'
      labelEl.textContent = label
      const detailEl = document.createElement('span')
      detailEl.className = 'detail'
      row.append(stateEl, labelEl, detailEl)
      stepsEl.appendChild(row)
      stepRows.set(id, row)
    }
    row.querySelector('.state').className = 'state ' + (state || 'pending')
    row.classList.toggle('running', state === 'running')
    row.querySelector('.detail').textContent = detail || ''
  })
  window.dshDesktop.onFailure((text) => {
    statusEl.textContent = 'Failed to start DeepSeek Harness.'
    errorEl.textContent = text
    errorEl.style.display = 'block'
    quitEl.style.display = 'block'
  })
  quitEl.addEventListener('click', () => window.dshDesktop.quit())
})()
