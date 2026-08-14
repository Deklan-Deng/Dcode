/**
 * Standalone test for the updater pipeline: run a check against the official
 * repository, then rehearse applyUpdate (fast-forward no-op + install + build).
 * Run: node test-updater.mjs
 * @module dsh-desktop/test-updater
 */

import { applyUpdate, checkForUpdates } from './src/updater.mjs'

console.log('== checkForUpdates ==')
const check = await checkForUpdates({ onProgress: (line) => console.log('[check]', line) })
console.log('RESULT', JSON.stringify(check, null, 2))

console.log('== applyUpdate rehearsal ==')
try {
  await applyUpdate({ onProgress: (line) => console.log('[apply]', line) })
  console.log('APPLY OK')
} catch (error) {
  console.error('APPLY FAILED:', error.message)
  process.exit(1)
}
