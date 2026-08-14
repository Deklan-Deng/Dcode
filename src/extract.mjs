/**
 * Streaming tar.gz extractor for the harness snapshot.
 *
 * Handles the entry types the snapshot actually contains: files, directories,
 * symlinks (pnpm's node_modules farm), GNU long-name ('L') and PAX ('x')
 * extended headers for long paths. File payloads are streamed straight to
 * disk (no large in-memory buffers). Paths are sanitized against traversal.
 *
 * A sidecar meta file (written by scripts/pack-harness.mjs) supplies the file
 * count so extraction can report percentage progress.
 * @module dcode/extract
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const BLOCK = 512

/** Parse the octal size field (space/NUL padded). */
function parseSize(field) {
  const raw = field.toString('binary').replace(/[\0 ]+$/, '').trim()
  if (raw === '') return 0
  const value = Number.parseInt(raw, 8)
  return Number.isFinite(value) ? value : 0
}

const trimNul = (buf) => {
  const end = buf.indexOf(0)
  return (end === -1 ? buf : buf.subarray(0, end)).toString('utf8')
}

/** Safe destination path inside destDir for a tar entry name. */
function resolveDest(destDir, name) {
  const clean = name.replace(/^\.?\//, '').replace(/\/+$/, '')
  if (clean === '' || clean.includes('\0')) return null
  const abs = path.resolve(destDir, clean)
  if (abs !== destDir && !abs.startsWith(destDir + path.sep)) return null
  return abs
}

/** Parse one 512-byte header block; returns null at the end-of-archive marker. */
function parseHeader(block) {
  if (block[156] === 0) return null
  return {
    name: trimNul(block.subarray(0, 100)),
    size: parseSize(block.subarray(124, 136)),
    type: String.fromCharCode(block[156]),
    linkname: trimNul(block.subarray(157, 257)),
  }
}

/**
 * Walk the archive once with a chunk-queue state machine. File payloads are
 * delivered as incremental buffers through the handlers, so extraction never
 * needs to hold a whole file in memory.
 *
 * Handlers: onFileStart(entry), onFileData(entry, chunk), onFileEnd(entry),
 * onEntry(entry) for directories/symlinks, plus onFinish().
 */
export function walkTarGz(file, handlers) {  return new Promise((resolve, reject) => {
    const queue = []
    let buffered = 0
    let mode = 'header'
    let need = BLOCK
    let longName = null
    let paxPath = null
    let pendingLink = null
    let current = null
    let fileLeft = 0

    const consume = (count) => {
      let remaining = count
      while (remaining > 0) {
        const head = queue[0]
        if (head.length <= remaining) {
          queue.shift()
          remaining -= head.length
        } else {
          queue[0] = head.subarray(remaining)
          remaining = 0
        }
      }
      buffered -= count
    }

    const take = (count) => {
      if (count === 0) return Buffer.alloc(0)
      const out = Buffer.allocUnsafe(count)
      let offset = 0
      let index = 0
      while (offset < count) {
        const head = queue[index]
        const chunk = Math.min(head.length, count - offset)
        head.copy(out, offset, 0, chunk)
        offset += chunk
        index += 1
      }
      return out
    }

    const process = () => {
      while (true) {
        if (mode === 'header') {
          if (buffered < BLOCK) return
          const header = parseHeader(take(BLOCK))
          consume(BLOCK)
          if (header === null) {
            mode = 'done'
            return
          }
          const padded = Math.ceil(header.size / BLOCK) * BLOCK
          if (header.type === 'L' || header.type === 'K' || header.type === 'x' || header.type === 'g') {
            current = { type: header.type, size: header.size }
            mode = 'meta'
            need = padded
          } else {
            current = {
              name: longName ?? paxPath ?? header.name,
              size: header.size,
              type: header.type,
              linkname: pendingLink ?? header.linkname,
            }
            longName = null
            paxPath = null
            pendingLink = null
            if (header.type === '0' || header.type === '7') {
              mode = 'file'
              need = padded
              fileLeft = header.size
              handlers.onFileStart(current)
            } else {
              mode = 'skip'
              need = padded
            }
          }
        } else if (mode === 'meta') {
          if (buffered < need) return
          const content = take(current.size).toString('utf8')
          consume(need)
          if (current.type === 'L') {
            longName = content.replace(/\0+$/, '')
          } else if (current.type === 'K') {
            pendingLink = content.replace(/\0+$/, '')
          } else {
            for (const record of content.split('\n')) {
              const match = /^\d+ path=(.*)$/.exec(record)
              if (match !== null) paxPath = match[1]
            }
          }
          mode = 'header'
          need = BLOCK
        } else if (mode === 'file') {
          if (buffered === 0) return
          const chunkSize = Math.min(buffered, fileLeft)
          const data = take(chunkSize)
          consume(chunkSize)
          fileLeft -= chunkSize
          handlers.onFileData(current, data)
          if (fileLeft === 0) {
            handlers.onFileEnd(current)
            const padding = need - current.size
            if (padding > 0) {
              mode = 'pad'
              need = padding
            } else {
              mode = 'header'
              need = BLOCK
            }
          }
        } else if (mode === 'skip' || mode === 'pad') {
          if (buffered === 0) return
          const chunkSize = Math.min(buffered, need)
          consume(chunkSize)
          need -= chunkSize
          if (need === 0) {
            if (mode === 'skip') handlers.onEntry(current)
            mode = 'header'
            need = BLOCK
          }
        } else {
          return
        }
      }
    }

    const stream = fs.createReadStream(file).pipe(zlib.createGunzip())
    stream.on('error', reject)
    stream.on('data', (chunk) => {
      queue.push(chunk)
      buffered += chunk.length
      process()
    })
    stream.on('end', () => {
      handlers.onFinish()
      resolve()
    })
  })
}

/** Count file entries + total bytes (used by the pack script for the sidecar meta). */
export function countTarGz(file) {  return new Promise((resolve, reject) => {
    let files = 0
    let bytes = 0
    walkTarGz(file, {
      onFileStart: (entry) => {
        files += 1
        bytes += entry.size
      },
      onFileData: () => {},
      onFileEnd: () => {},
      onEntry: () => {},
      onFinish: () => resolve({ files, bytes }),
    }).catch(reject)
  })
}

/**
 * Extract a .tar.gz into destDir in two streaming passes:
 *  1. directories + symlinks first (pnpm's symlink farm can precede its
 *     targets in the archive, so files must wait until every link exists),
 *  2. file payloads with progress.
 * @param onProgress({ done, total, pct, mb }) — file-count based when total is
 * known (sidecar meta), otherwise decompressed-megabyte based.
 * @returns true on success.
 */
export async function extractTarGz(file, destDir, { onProgress = () => {}, totalFiles = 0 } = {}) {
  try {
    const noop = () => {}
    await walkTarGz(file, {
      onFileStart: noop,
      onFileData: noop,
      onFileEnd: noop,
      onEntry: (entry) => {
        const dest = resolveDest(destDir, entry.name)
        if (dest === null) return
        if (entry.type === '5') {
          fs.mkdirSync(dest, { recursive: true })
        } else if (entry.type === '2') {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          try {
            fs.symlinkSync(entry.linkname, dest)
          } catch {
            // Broken symlink (e.g. platform-specific deps): tolerated.
          }
        }
      },
      onFinish: noop,
    })

    let done = 0
    let mb = 0
    let lastMarker = -1
    await walkTarGz(file, {
      onFileStart: (entry) => {
        const dest = resolveDest(destDir, entry.name)
        if (dest === null) return
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
        } catch {
          // A broken symlink in the path: tolerated; the write below fails too.
        }
        entry._stream = fs.createWriteStream(dest)
        entry._dest = dest
        entry._head = null
      },
      onFileData: (entry, data) => {
        if (entry._stream === undefined) return
        if (entry._head === null) entry._head = data
        entry._stream.write(data)
      },
      onFileEnd: (entry) => {
        if (entry._stream === undefined) return
        entry._stream.end()
        if (entry.size > 2 && entry._head !== null && entry._head.toString('utf8', 0, 2) === '#!') {
          try {
            fs.chmodSync(entry._dest, 0o755)
          } catch {
            // chmod is best-effort.
          }
        }
        done += 1
        mb += entry.size / 1048576
        const pct = totalFiles > 0 ? Math.round((done / totalFiles) * 100) : -1
        const marker = totalFiles > 0 ? pct : Math.round(mb)
        if (marker !== lastMarker) {
          lastMarker = marker
          onProgress({ done, total: totalFiles, pct, mb: Math.round(mb) })
        }
      },
      onEntry: noop,
      onFinish: noop,
    })
    return true
  } catch (error) {
    console.error('[extract]', error)
    return false
  }
}
