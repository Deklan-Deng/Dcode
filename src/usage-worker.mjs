/**
 * Usage aggregation worker: a fresh, short-lived process that computes the
 * usage snapshot once and prints it as JSON. Runs under system node when
 * available, otherwise Electron's bundled node — either way every call gets a
 * clean V8 heap, which sidesteps the repeated-parse crash in Electron's
 * bundled Node 22.21 when aggregation runs inside the app process.
 * @module dcode/usage-worker
 */

import { collectUsage } from './usage.mjs'

process.stdout.write(JSON.stringify(collectUsage()))
