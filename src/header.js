/* Custom header chrome: a slim drag strip with the terminal toggle button. */
(function () {
  const act = (name) => window.dshDesktop.headerAction(name)
  document.getElementById('term-toggle').addEventListener('click', () => act('toggle-terminal'))
})()
