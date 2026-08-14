/* Custom header chrome: a slim drag strip with terminal + GitHub buttons. */
(function () {
  const act = (name) => window.dshDesktop.headerAction(name)
  document.getElementById('term-toggle').addEventListener('click', () => act('toggle-terminal'))
  document.getElementById('github').addEventListener('click', () => act('open-github'))
})()
