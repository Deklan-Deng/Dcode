/**
 * Token-usage aggregation over the durable dsh session logs.
 *
 * Reads the per-session durable logs under ~/.dsh/sessions (concatenated
 * zstd frames — the same framing the harness's session-persistence backend
 * uses), collects the provider-reported usage chunks, and folds them into
 * per-day totals for the settings usage dashboard (daily grid plus
 * day/week/month/total figures).
 *
 * Accounting follows the token-meter semantics: usage samples are keyed by
 * (session, turn, step) and the LAST sample wins (a final assistant-message
 * usage replaces earlier streaming chunks for the same step), so streaming
 * chunk storms never double-count.
 * @module dcode/usage
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(__dirname, 'usage-worker.mjs')

const ZSTD_MAGIC = 0xfd2fb528

/** Structural scan of a concatenated-zstd container (mirrors the harness). */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) break
    offset += remaining
    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) {
        torn = true
        break
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        torn = true
        break
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (torn) break // incomplete final frame: ignore (only the tail batch is lost)
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Iterate durable events of one session artifact without retaining them:
 * each JSONL line is parsed, handed to onEvent, then dropped. (Retaining the
 * parsed event arrays across several large sessions provokes a V8 heap bug in
 * Electron's bundled Node 22.21 — streaming the extraction keeps the heap
 * flat and avoids it entirely.)
 */
function forEachSessionEvent(file, onEvent) {
  try {
    const buffer = fs.readFileSync(file)
    for (const frame of scanZstdFrames(buffer)) {
      const plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
      for (const line of plain.split('\n')) {
        if (line.trim() === '') continue
        try {
          onEvent(JSON.parse(line))
        } catch {
          // A torn line at a frame boundary: skip.
        }
      }
    }
  } catch (error) {
    console.error(`[usage] failed to read ${file}:`, error instanceof Error ? error.message : error)
  }
}

const dayKey = (ms) => {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Expose the usage snapshot to the GUI over IPC (settings dashboard). */
export function registerUsageIpc(ipcMain, resolveRuntime) {
  // Fresh process per recompute: repeated heavy zstd+JSON parsing inside
  // Electron's bundled Node 22.21 crashes V8; a short-lived worker with a
  // clean heap is stable on every runtime.
  let cache = null
  let lastCheck = 0

  const stamp = () => {
    try {
      const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
      let latest = 0
      for (const workspace of fs.readdirSync(sessionsRoot)) {
        const workspaceDir = path.join(sessionsRoot, workspace)
        if (!fs.statSync(workspaceDir).isDirectory()) continue
        for (const sessionName of fs.readdirSync(workspaceDir)) {
          const file = path.join(workspaceDir, sessionName, 'session.jsonl.zstd')
          try {
            const mtime = fs.statSync(file).mtimeMs
            if (mtime > latest) latest = mtime
          } catch {
            // Session dir without a durable log yet.
          }
        }
      }
      return latest
    } catch {
      return 0
    }
  }

  ipcMain.handle('usage:get', async () => {
    const fileStamp = stamp()
    const now = Date.now()
    if (cache !== null && cache.stamp === fileStamp && now - lastCheck < 60000) {
      return cache.data
    }
    lastCheck = now
    try {
      const runtime = await resolveRuntime()
      const env = { ...process.env }
      if (runtime.electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'
      const output = await new Promise((resolve) => {
        const child = spawn(runtime.cmd, [WORKER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
          out += chunk
        })
        child.stderr.on('data', (chunk) => {
          err += chunk
        })
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Worker already gone.
          }
        }, 30000)
        child.on('exit', (code) => {
          clearTimeout(timer)
          resolve({ code, out, err })
        })
      })
      if (output.code !== 0 || output.out.trim() === '') {
        throw new Error(output.err.slice(-500) || 'usage worker failed')
      }
      const data = { ok: true, ...JSON.parse(output.out.trim()) }
      cache = { stamp: fileStamp, data }
      return data
    } catch (error) {
      if (cache !== null) return cache.data
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/**
 * Aggregate usage across every session into daily buckets.
 * @returns { today, week, month, total, days } — days covers the last 26
 * weeks (182 entries, oldest first); week = rolling 7 days; month = the
 * current calendar month; all figures are token counts.
 */
export function collectUsage() {
  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
  const samples = new Map() // (sessionId:turn:step) -> usage sample
  try {
    for (const workspace of fs.readdirSync(sessionsRoot)) {
      const workspaceDir = path.join(sessionsRoot, workspace)
      let stat
      try {
        stat = fs.statSync(workspaceDir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      for (const sessionName of fs.readdirSync(workspaceDir)) {
        const file = path.join(workspaceDir, sessionName, 'session.jsonl.zstd')
        if (!fs.existsSync(file)) continue
        forEachSessionEvent(file, (event) => {
          if (event.type !== 'assistant/chunk') return
          const chunk = event.data?.chunk ?? event.chunk
          if (chunk === undefined || chunk === null || chunk.type !== 'usage') return
          const usage = chunk.usage ?? {}
          const turn = event.data?.turn ?? chunk.turn ?? '?'
          const step = event.data?.step ?? chunk.step ?? '?'
          const key = `${sessionName}:${turn}:${step}`
          // Last-wins per (session, turn, step): the final assistant-message
          // usage replaces earlier streaming samples of the same step.
          samples.set(key, {
            time: typeof event.time === 'number' ? event.time : Date.now(),
            input: Number(usage.inputTokens ?? usage.promptTokens ?? 0),
            output: Number(usage.outputTokens ?? usage.completionTokens ?? 0),
            cacheRead: Number(usage.cacheReadTokens ?? 0),
            cacheWrite: Number(usage.cacheWriteTokens ?? 0),
          })
        })
      }
    }
  } catch (error) {
    console.error('[usage] scan failed:', error instanceof Error ? error.message : error)
  }

  const days = new Map()
  for (const sample of samples.values()) {
    const key = dayKey(sample.time)
    const bucket = days.get(key) ?? { ...ZERO }
    bucket.input += sample.input
    bucket.output += sample.output
    bucket.cacheRead += sample.cacheRead
    bucket.cacheWrite += sample.cacheWrite
    bucket.total += sample.input + sample.output + sample.cacheRead + sample.cacheWrite
    days.set(key, bucket)
  }

  const todayKey = dayKey(Date.now())
  const now = new Date()
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const weekKeys = []
  for (let i = 0; i < 7; i += 1) weekKeys.push(dayKey(Date.now() - i * 86400000))

  let today = { ...ZERO }
  let week = { ...ZERO }
  let month = { ...ZERO }
  let total = { ...ZERO }
  for (const [key, bucket] of days) {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      total[field] += bucket[field]
    }
    if (key === todayKey) today = bucket
    if (weekKeys.includes(key)) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
        week[field] += bucket[field]
      }
    }
    if (key.startsWith(monthPrefix)) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
        month[field] += bucket[field]
      }
    }
  }

  // Daily series for the grid: the last 26 weeks, zero-filled, oldest first.
  const series = []
  for (let i = 25 * 7; i >= 0; i -= 1) {
    const key = dayKey(Date.now() - i * 86400000)
    series.push({ date: key, ...(days.get(key) ?? { ...ZERO }) })
  }

  return { today, week, month, total, days: series }
}
