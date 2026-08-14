/**
 * Standalone test for the updater module: version comparison, release-feed
 * check, and an applyAppUpdate rehearsal (pull + npm install).
 * Run: node test-updater.mjs
 * @module dsh-desktop/test-updater
 */

import { applyAppUpdate, checkForAppUpdate, compareVersions, localAppVersion } from './src/updater.mjs'

const cases = [
  ['0.1.0', '0.1.1', -1],
  ['1.0.0', '1.0.0', 0],
  ['0.2.0', '0.1.9', 1],
  ['v1.2.3', '1.2.4', -1],
  ['1.0.0-rc.1', '1.0.0', -1],
  ['0.1.0', '0.1.0-rc.6', 1],
]
let ok = true
for (const [a, b, expected] of cases) {
  const got = compareVersions(a, b)
  if (got !== expected) {
    ok = false
    console.error(`FAIL compare(${a}, ${b}) = ${got}, expected ${expected}`)
  }
}
console.log(ok ? 'COMPARE OK' : 'COMPARE FAILED')
console.log('local version:', localAppVersion())

console.log('== checkForAppUpdate (update-config.json repo) ==')
const check = await checkForAppUpdate({ onProgress: (line) => console.log('[check]', line) })
console.log('RESULT', JSON.stringify(check, null, 2))

if (check.hasUpdate) {
  console.log('== applyAppUpdate rehearsal (needs git origin + tracking) ==')
  try {
    await applyAppUpdate({ onProgress: (line) => console.log('[apply]', line) })
    console.log('APPLY OK')
  } catch (error) {
    console.error('APPLY FAILED:', error.message)
    process.exit(1)
  }
}
