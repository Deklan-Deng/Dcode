/**
 * Packaged-mode simulation: runs the EXACT first-run path a packaged app
 * takes (ensureHarness with packaged=true extracting the snapshot into a
 * userData-like dir, then booting the pre-built CLI), without electron-builder.
 *
 * Run: node test-packaged.mjs
 * @module dcode/test-packaged
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_BUILT_ARGS, startServer } from './src/server.mjs'
import { ensureHarness } from './src/updater.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)))
const snapshotPath = path.join(root, 'pack', 'harness.tgz')
const snapshotMetaPath = path.join(root, 'pack', 'harness.meta.json')

const stepLog = (id, label, state, detail = '') => {
  console.log(`[step:${state}] ${label}${detail !== '' ? ` (${detail})` : ''}`)
}

const userDataLike = fs.mkdtempSync(path.join(os.tmpdir(), 'dcode-packaged-'))
console.log('userData-like dir:', userDataLike)

try {
  const ok = await ensureHarness({
    onProgress: (line) => console.log('  >', line),
    onStep: stepLog,
    packaged: true,
    harnessDir: path.join(userDataLike, 'harness'),
    snapshotPath,
    snapshotMetaPath,
    version: '0.1.0',
  })
  if (!ok) throw new Error('ensureHarness (packaged) failed')

  // Second call must be a no-op (version stamp matches).
  const second = await ensureHarness({
    onProgress: () => {},
    onStep: () => {},
    packaged: true,
    harnessDir: path.join(userDataLike, 'harness'),
    snapshotPath,
    snapshotMetaPath,
    version: '0.1.0',
  })
  if (!second) throw new Error('second ensureHarness call failed')

  console.log('Booting the BUILT harness from the extracted snapshot…')
  const handle = await startServer({
    log: (line) => console.log('  [server]', line),
    cwd: path.join(userDataLike, 'harness'),
    args: HARNESS_BUILT_ARGS,
  })
  console.log('READY', handle.url)

  const answered = await new Promise((resolve) => {
    const req = http.get(handle.url, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(5000, () => {
      req.destroy()
      resolve(false)
    })
  })
  console.log('HTTP answers:', answered)
  await handle.stop()
  console.log('PACKAGED SIMULATION OK')
  process.exit(answered ? 0 : 1)
} catch (error) {
  console.error('PACKAGED SIMULATION FAILED:', error)
  process.exit(1)
} finally {
  fs.rmSync(userDataLike, { recursive: true, force: true })
}
