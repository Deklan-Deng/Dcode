/**
 * Standalone smoke test for server.mjs: boot the bundled dsh web server,
 * verify the readiness URL answers HTTP, then stop cleanly.
 * Run: node test-server.mjs
 * @module dsh-desktop/test-server
 */

import http from 'node:http'
import { startServer } from './src/server.mjs'

const log = (text) => console.log(text)

const handle = await startServer({ log, logFile: null })
log(`RESOLVED url=${handle.url} port=${handle.port}`)

// The readiness URL must serve the frontend index (status < 500).
const status = await new Promise((resolve) => {
  http.get(handle.url, (res) => {
    res.resume()
    resolve(res.statusCode)
  }).on('error', () => resolve(-1))
})
log(`HTTP status: ${status}`)

await handle.stop()
log('Stopped. Exited code:', handle.child.exitCode, 'signal:', handle.child.signalCode)

if (status >= 200 && status < 500) {
  console.log('SMOKE OK')
  process.exit(0)
} else {
  console.error('SMOKE FAILED: server did not answer HTTP')
  process.exit(1)
}
