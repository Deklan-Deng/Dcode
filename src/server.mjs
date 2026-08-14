/**
 * dsh server management: spawns the bundled deepseek-harness checkout's `web`
 * profile, watches its readiness line, and stops it cleanly on quit.
 * @module dcode/server
 */

import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { HARNESS_DIR } from './updater.mjs'

/**
 * The readiness signal: dsh prints exactly one URL line after its loader tree
 * settles, e.g. `dsh web: http://127.0.0.1:54123`.
 */
const READY_LINE = /^dsh web: (http:\/\/\S+)/m

/**
 * The source launcher: the exact command the official docs use
 * (`pnpm dsh web` runs `node --import tsx/esm apps/cli/src/bin.ts`).
 */
const HARNESS_ARGS = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0']

/** dsh engines floor: node ^22.19.0 || >=24. */
const MIN_NODE_MAJOR = 22

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run `node --version` once and report the major version, or null when unavailable. */
function systemNodeMajor(nodeBin) {
  return new Promise((resolve) => {
    execFile(nodeBin, ['--version'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null)
      const match = /^v(\d+)\./.exec(String(stdout).trim())
      resolve(match ? Number(match[1]) : null)
    })
  })
}

/**
 * Pick a Node runtime able to run dsh: the system `node` when it satisfies the
 * engines range, otherwise Electron's bundled Node via ELECTRON_RUN_AS_NODE.
 * @param log - status sink.
 * @returns spawn command plus whether the Electron-as-Node env switch is needed.
 */
export async function resolveNodeRuntime(log) {
  const systemNode = process.env.DSH_DESKTOP_NODE || 'node'
  const major = await systemNodeMajor(systemNode)
  if (major !== null && major >= MIN_NODE_MAJOR) {
    return { cmd: systemNode, electronAsNode: false }
  }
  log(
    major === null
      ? 'System node not found; using Electron\u2019s bundled Node.'
      : `System node v${major} is too old (dsh needs >= 22.19); using Electron\u2019s bundled Node.`,
  )
  return { cmd: process.execPath, electronAsNode: true }
}

/** One HEAD-less GET probe; resolves true when the server answers under 5xx. */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/** Poll the URL until the server answers, within timeoutMs. */
async function waitForHttp(url, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(url)) return true
    await delay(250)
  }
  log('Readiness line printed but the server never answered HTTP within the timeout.')
  return false
}

/** Stop the child: SIGINT (graceful, harness handles it), then SIGTERM, then SIGKILL. */
export async function stopChild(child, log) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return true
    await Promise.race([once(child, 'exit'), delay(4000)])
    return child.exitCode !== null || child.signalCode !== null
  }
  child.kill('SIGINT')
  if (await exited()) return
  log('Server ignored SIGINT; sending SIGTERM.')
  child.kill('SIGTERM')
  if (await exited()) return
  log('Server ignored SIGTERM; sending SIGKILL.')
  child.kill('SIGKILL')
  await once(child, 'exit').catch(() => {})
}

/**
 * Start the bundled dsh web server on an OS-assigned port and resolve once the
 * readiness line prints and the server answers HTTP.
 * @param opts.log - status sink (also appended to the log file).
 * @param opts.logFile - path to append the child's full stdout/stderr to.
 * @returns a handle with url, port, and a stop() that shuts the server down.
 */
export async function startServer({ log, logFile }) {
  const runtime = await resolveNodeRuntime(log)
  const childEnv = { ...process.env }
  if (runtime.electronAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1'
  const logStream = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.cmd, HARNESS_ARGS, {
      cwd: HARNESS_DIR,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (reason) => {
      if (settled) return
      settled = true
      const tail = `${reason}\n--- stderr tail ---\n${stderr.slice(-4000)}\n--- stdout tail ---\n${stdout.slice(-4000)}`
      reject(new Error(tail))
    }
    child.on('error', (err) => fail(`Failed to start dsh: ${err.message}`))
    child.on('exit', (code, signal) => {
      if (settled) return
      fail(`dsh exited before becoming ready (code ${code}, signal ${signal}).`)
    })

    // Resolve as soon as the accumulated output contains the readiness line.
    const watch = () => {
      if (settled) return
      const match = READY_LINE.exec(stdout) ?? READY_LINE.exec(stderr)
      if (match === null) return
      settled = true
      const url = match[1]
      const port = Number(new URL(url).port)
      void waitForHttp(url, 15000, log).then((ok) => {
        if (!ok) {
          reject(new Error(`dsh printed ${url} but never answered HTTP.\n--- stderr tail ---\n${stderr.slice(-4000)}`))
          return
        }
        log(`Server ready at ${url}`)
        resolve({
          url,
          port,
          child,
          stop: () => stopChild(child, log).finally(() => logStream?.end()),
        })
      })
    }
    // Keep only a bounded in-memory tail; the full stream goes to the log file.
    const TAIL_LIMIT = 16_384
    const ingest = (buffer) => (chunk) => {
      const text = String(chunk)
      if (buffer === 'stdout') stdout = (stdout + text).slice(-TAIL_LIMIT)
      else stderr = (stderr + text).slice(-TAIL_LIMIT)
      logStream?.write(text)
      watch()
    }
    child.stdout.on('data', ingest('stdout'))
    child.stderr.on('data', ingest('stderr'))
  })
}
