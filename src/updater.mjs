/**
 * Desktop-app lifecycle around the bundled deepseek-harness source.
 *
 * Two separate concerns:
 * - ensureHarness: make the BUNDLED official harness checkout runnable
 *   (clone / install / build), tracking a build fingerprint so a changed
 *   checkout commit (submodule bump or manual pull) triggers a rebuild.
 * - App self-update check: compare THIS desktop app's own version (package.json)
 *   against the latest GitHub Release of the user's own repository
 *   (update-config.json). The install itself is package-based and lives in
 *   main.mjs via electron-updater (dmg on macOS, exe on Windows).
 *
 * The official harness repository is NOT watched for updates: it is a bundled
 * dependency whose version moves with this app's releases.
 * @module dcode/updater
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractTarGz } from './extract.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** The desktop app's own root (src/'s parent). */
export const APP_ROOT = path.join(__dirname, '..')

/** The official DeepSeek Harness repository this checkout bundles. */
export const OFFICIAL_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** Bundled checkout location: <app root>/harness. */
export const HARNESS_DIR = path.join(APP_ROOT, 'harness')

/** pnpm workspaces write a .modules.yaml marker after a successful install. */
const PNPM_INSTALL_MARKER = 'node_modules/.modules.yaml'
/** The web profile needs the built frontend dist to serve the GUI. */
const WEB_DIST_INDEX = 'apps/web/dist/index.html'
/** Which checkout commit the current build belongs to. */
const HARNESS_STATE_FILE = '.harness-state.json'
/** Stamps the extracted snapshot with the app version it belongs to. */
const VERSION_STAMP_FILE = '.dcode-version'

/**
 * Run one command to completion, streaming combined output lines.
 * @param opts.onLine - called for each output line (progress reporting).
 * @returns the exit code; never throws on spawn failure (resolves with code 1
 * and an error line).
 */
export function run(command, args, { cwd, onLine, env = process.env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const message = `cannot run ${command}: ${error instanceof Error ? error.message : String(error)}`
      onLine?.(message)
      resolve({ code: 1, output: message })
      return
    }
    const ingest = (chunk) => {
      const text = String(chunk)
      output = (output + text).slice(-32768)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== '') onLine?.(line.trim())
      }
    }
    child.stdout.on('data', ingest)
    child.stderr.on('data', ingest)
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, timeoutMs).unref()
    }
    child.on('error', (error) => {
      onLine?.(`spawn error: ${error.message}`)
      resolve({ code: 1, output })
    })
    child.on('exit', (code) => resolve({ code: code ?? 1, output }))
  })
}

// ---------------------------------------------------------------------------
// Bundled harness bootstrap
// ---------------------------------------------------------------------------

/** The pnpm-carrying environment the install step needs. */
function pnpmEnv() {
  return {
    ...process.env,
    CI: 'true',
    // Corepack shims (e.g. ServBay's pnpm alias) pin the exact packageManager
    // version; keep its cache inside the workspace so installs never touch ~/.cache.
    COREPACK_HOME: path.join(APP_ROOT, '.corepack'),
    npm_config_cache: path.join(APP_ROOT, '.pnpm-cache'),
  }
}

/** Find a working pnpm: plain `pnpm`, then corepack (bundled with Node 22+). */
function resolvePnpm(onLine) {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) return 'pnpm'
  const corepack = spawnSync('corepack', ['pnpm', '--version'], { encoding: 'utf8' })
  if (corepack.status === 0) return 'corepack pnpm'
  onLine?.('pnpm not found and corepack unavailable; dependency install will fail')
  return 'pnpm'
}

/** Install workspace dependencies of the bundled checkout. */
async function installHarness(onLine) {
  onLine?.('安装依赖 (pnpm install)…')
  return run(resolvePnpm(onLine), [
    'install',
    '--store-dir', path.join(APP_ROOT, '.pnpm-store'),
    '--reporter', 'append-only',
  ], { cwd: HARNESS_DIR, onLine, env: pnpmEnv(), timeoutMs: 15 * 60_000 })
}

/** Build the bundled checkout (lib + web frontend). */
async function buildHarness(onLine) {
  onLine?.('构建 harness (pnpm run build)…')
  return run(resolvePnpm(onLine), ['run', 'build'], {
    cwd: HARNESS_DIR,
    onLine,
    env: pnpmEnv(),
    timeoutMs: 30 * 60_000,
  })
}

/** Clone the official repository into the bundled location (shallow, default branch). */
async function cloneHarness(onLine) {
  onLine?.('克隆官方仓库 deepseek-ai/deepseek-harness…')
  fs.mkdirSync(path.dirname(HARNESS_DIR), { recursive: true })
  return run('git', ['clone', '--depth', '1', OFFICIAL_REPO_URL, HARNESS_DIR], {
    onLine,
    timeoutMs: 20 * 60_000,
  })
}

const harnessExists = (relative) => fs.existsSync(path.join(HARNESS_DIR, relative))

const harnessHead = () => {
  const probe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: HARNESS_DIR, encoding: 'utf8' })
  return probe.status === 0 ? probe.stdout.trim() : ''
}

const readHarnessState = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, HARNESS_STATE_FILE), 'utf8'))
  } catch {
    return {}
  }
}

const writeHarnessState = (state) => {
  try {
    fs.writeFileSync(path.join(APP_ROOT, HARNESS_STATE_FILE), JSON.stringify(state))
  } catch {
    // State persistence must never take the app down.
  }
}

/**
 * Make the bundled checkout runnable. The build fingerprint ensures a changed
 * checkout commit (e.g. the app's release bumped the bundled harness, or a
 * manual pull inside harness/) triggers a fresh install + build; an unchanged
 * commit skips both. Returns true when the harness is runnable.
 *
 * Packaged mode (packaged=true) never touches git/pnpm/network: the harness is
 * a fixed snapshot shipped inside the app (pack/harness.tgz) and is extracted
 * once per app version into harnessDir. The official repository is therefore
 * never consulted at runtime — local source modifications can't conflict with
 * anything, and the bundled harness only moves with the app's own releases.
 *
 * onStep(id, label, state, detail) reports checklist steps for the splash UI.
 */
export async function ensureHarness({
  onProgress = () => {},
  onStep = () => {},
  packaged = false,
  harnessDir = HARNESS_DIR,
  snapshotPath = null,
  snapshotMetaPath = null,
  version = '0.0.0',
} = {}) {
  if (packaged) {
    const stampFile = path.join(harnessDir, VERSION_STAMP_FILE)
    let stamped = ''
    try {
      stamped = fs.readFileSync(stampFile, 'utf8').trim()
    } catch {
      // First run: nothing stamped yet.
    }
    const runnable =
      stamped === version && fs.existsSync(path.join(harnessDir, 'apps', 'cli', 'lib', 'bin.js'))
    if (runnable) return true

    if (snapshotPath === null || !fs.existsSync(snapshotPath)) {
      onProgress('内置 harness 快照缺失（安装包损坏？）')
      onStep('extract', '解压内置 DeepSeek Harness', 'error', '快照缺失')
      return false
    }
    onProgress('首次运行：解压内置 harness 快照')
    onStep('extract', '解压内置 DeepSeek Harness', 'running')
    try {
      fs.rmSync(harnessDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of the previous snapshot.
    }
    fs.mkdirSync(harnessDir, { recursive: true })

    let totalFiles = 0
    if (snapshotMetaPath !== null && fs.existsSync(snapshotMetaPath)) {
      try {
        totalFiles = Number(JSON.parse(fs.readFileSync(snapshotMetaPath, 'utf8')).files ?? 0)
      } catch {
        totalFiles = 0
      }
    }
    const ok = await extractTarGz(snapshotPath, harnessDir, {
      totalFiles,
      onProgress: ({ pct, mb }) => {
        const detail = totalFiles > 0 ? `${pct}%` : `${mb} MB`
        onStep('extract', '解压内置 DeepSeek Harness', 'running', detail)
      },
    })
    if (!ok) {
      onStep('extract', '解压内置 DeepSeek Harness', 'error', '失败')
      return false
    }
    try {
      fs.writeFileSync(stampFile, version)
    } catch {
      // Stamp persistence must never take the app down.
    }
    onStep('extract', '解压内置 DeepSeek Harness', 'done')
    return true
  }

  if (!harnessExists('.git')) {
    onProgress('内置 harness 缺失，首次引导：克隆官方仓库')
    onStep('clone', '克隆官方仓库 deepseek-ai/deepseek-harness', 'running')
    const clone = await cloneHarness(onProgress)
    if (clone.code !== 0) {
      onProgress(`克隆失败：${clone.output.slice(-2000)}`)
      onStep('clone', '克隆官方仓库', 'error', '失败')
      return false
    }
    onStep('clone', '克隆官方仓库', 'done')
  }
  const head = harnessHead()
  if (head === '') {
    onProgress('无法读取内置 harness 的 git HEAD，引导中止')
    return false
  }
  const state = readHarnessState()
  const commitChanged = state.builtCommit !== head
  if (commitChanged && !harnessExists(PNPM_INSTALL_MARKER)) {
    onProgress('依赖缺失，首次引导：安装依赖')
    onStep('install', '安装依赖 (pnpm install)', 'running')
    const install = await installHarness(onProgress)
    if (install.code !== 0) {
      onProgress(`依赖安装失败：${install.output.slice(-2000)}`)
      onStep('install', '安装依赖', 'error', '失败')
      return false
    }
    onStep('install', '安装依赖', 'done')
  }
  if (commitChanged || !harnessExists(WEB_DIST_INDEX)) {
    onProgress(commitChanged ? '内置 harness 版本变化，重新构建' : '首次引导：构建前端与库')
    onStep('build', '构建前端与库 (pnpm run build)', 'running')
    const build = await buildHarness(onProgress)
    if (build.code !== 0) {
      onProgress(`构建失败：${build.output.slice(-2000)}`)
      onStep('build', '构建前端与库', 'error', '失败')
      return false
    }
    writeHarnessState({ builtCommit: head })
    onStep('build', '构建前端与库', 'done')
  }
  return true
}

// ---------------------------------------------------------------------------
// Desktop app self-update (own version, own GitHub releases)
// ---------------------------------------------------------------------------

/** Compare two semver-ish versions (`1.2.3`, `v1.2.3`, `1.2.3-rc.1`). */
export function compareVersions(a, b) {
  const parse = (raw) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(raw).trim())
    if (match === null) return null
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  return pa.pre > pb.pre ? 1 : -1
}

/** This app's own version, from its package.json. */
export function localAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** The self-update source: `{ "repo": "<owner>/<name>" }` in update-config.json. */
function readUpdateConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'update-config.json'), 'utf8'))
    return { repo: String(config.repo ?? '').trim() }
  } catch {
    return { repo: '' }
  }
}

/**
 * Check the app's own GitHub Releases for a newer version than the local one.
 * Resolves to `{ configured: false }` when update-config.json has no repo yet
 * (the app is not on GitHub), or to `{ hasUpdate, current, latest, tag }`.
 * Failures are reported through `error` and resolve to hasUpdate: false — a
 * flaky network must never disturb a running app.
 */
export async function checkForAppUpdate({ onProgress = () => {} } = {}) {
  const { repo } = readUpdateConfig()
  if (repo === '') {
    onProgress('未配置更新源（update-config.json 的 repo 为空），跳过自更新检查')
    return { configured: false }
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'dcode-desktop', Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return { configured: true, error: `GitHub API ${response.status}` }
    const data = await response.json()
    const tag = String(data.tag_name ?? '')
    const latest = tag.replace(/^v/, '')
    const current = localAppVersion()
    return {
      configured: true,
      current,
      latest,
      tag,
      hasUpdate: compareVersions(current, latest) < 0,
      url: typeof data.html_url === 'string' ? data.html_url : '',
    }
  } catch (error) {
    return { configured: true, error: error instanceof Error ? error.message : String(error) }
  }
}

