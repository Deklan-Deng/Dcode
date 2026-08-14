/**
 * Pack the bundled harness checkout into a single snapshot tarball for
 * electron-builder's extraResources. The snapshot ships the FULL tree
 * (source + built lib/dist + node_modules, symlinks preserved) minus git and
 * cache directories, so the packaged app needs no network, no git and no pnpm:
 * it just extracts the snapshot on first run.
 *
 * Run: node scripts/pack-harness.mjs   (also wired into the dist:* scripts)
 * @module dcode/pack-harness
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { countTarGz } from '../src/extract.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const harnessDir = path.join(root, 'harness')
const outDir = path.join(root, 'pack')
const outFile = path.join(outDir, 'harness.tgz')

const builtCli = path.join(harnessDir, 'apps', 'cli', 'lib', 'bin.js')
const builtWeb = path.join(harnessDir, 'apps', 'web', 'dist', 'index.html')
for (const [label, file] of [
  ['built CLI', builtCli],
  ['built web frontend', builtWeb],
]) {
  if (!fs.existsSync(file)) {
    console.error(`✗ ${label} missing: ${file}\n  Build the harness first (pnpm run build in harness/).`)
    process.exit(1)
  }
}

fs.mkdirSync(outDir, { recursive: true })
if (fs.existsSync(outFile)) fs.rmSync(outFile)

// -z gzip; do NOT dereference symlinks: pnpm's node_modules is a symlink farm
// into .pnpm — keeping the links preserves the structure without duplication.
// COPYFILE_DISABLE=1 stops macOS tar from adding useless ._ AppleDouble entries.
// --format gnutar keeps long names in simple 'L'/'K' records (no pax xattr noise).
const result = spawnSync(
  'tar',
  [
    '--format', 'gnutar',
    '-czf', outFile,
    '--exclude=.git',
    '--exclude=.cache',
    '--exclude=.vite-temp',
    '-C', harnessDir,
    '.',
  ],
  { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } },
)
if (result.status !== 0) process.exit(result.status ?? 1)

const mb = (fs.statSync(outFile).size / 1048576).toFixed(1)
console.log(`✓ packed ${outFile} (${mb} MB)`)

// Sidecar meta: file count + uncompressed bytes drive the extraction progress.
const { files, bytes } = await countTarGz(outFile)
const metaFile = path.join(outDir, 'harness.meta.json')
fs.writeFileSync(metaFile, JSON.stringify({ files, bytes }, null, 2))
console.log(`✓ meta ${metaFile} (${files} files, ${(bytes / 1048576).toFixed(0)} MB uncompressed)`)
