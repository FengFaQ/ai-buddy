/**
 * Run every suite in this directory.
 *
 * Usage:
 *   node test/run.mjs            # the offline suites
 *   node test/run.mjs --live     # also the live suite (needs a running host)
 *
 * The live suite creates real AI conversations against a running DSH host, so
 * it is opt-in: it costs model quota and it writes to the host's session
 * store. The offline suites touch nothing outside a temp directory.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The offline suites: no host, no network, no model calls. */
const OFFLINE = [
  ['modules.mjs', 'module layer'],
  ['web.mjs', 'workbench HTTP API'],
  ['json.mjs', 'lossless JSON tool results'],
  ['team.mjs', 'team subsystem'],
  ['host-safety.mjs', 'host process safety'],
  ['autospawn.mjs', 'no auto-created conversations'],
  ['rights.mjs', 'a released member holds no execution right'],
  ['identity.mjs', 'identity and task resolution (field report bugs 1/2/5/7)'],
]

/** The suite that needs a live host. */
const LIVE = [['live.mjs', 'live end-to-end (real model call)']]

const wantLive = process.argv.includes('--live')
const suites = wantLive ? [...OFFLINE, ...LIVE] : OFFLINE

let totalPassed = 0
let totalFailed = 0
let broken = 0
/** Suites whose tally could not be read — reported, never silently ignored. */
const untallied = []

for (const [file, label] of suites) {
  const suite = path.join(HERE, file)
  if (!fs.existsSync(suite)) {
    console.log(`SKIP ${file} (missing)`)
    broken++
    continue
  }
  process.stdout.write(`\n--- ${file}  ${label} ---\n`)
  const result = spawnSync(process.execPath, [suite], { encoding: 'utf8' })
  process.stdout.write(result.stdout ?? '')
  if (result.stderr) process.stderr.write(result.stderr)

  /**
   * The suites print their tally in one of two shapes — `N passed, M failed`
   * or `PASS N FAIL M`. Both are accepted, because a runner that silently
   * under-counts is worse than no runner at all: it would report a green run
   * that covered only part of the suites.
   */
  const stdout = result.stdout ?? ''
  const byPhrase = stdout.match(/(\d+) passed, (\d+) failed/)
  const byCounts = stdout.match(/^PASS\s+(\d+)\s+FAIL\s+(\d+)\s*$/m)
  const tally = byPhrase ?? byCounts
  if (tally) {
    totalPassed += Number(tally[1])
    totalFailed += Number(tally[2])
  } else {
    untallied.push(file)
  }
  if (result.status !== 0) {
    totalFailed += tally ? 0 : 1
    broken++
  }
}

console.log('')
console.log('='.repeat(60))
console.log(
  `ai-buddy test suites: ${totalPassed} passed, ${totalFailed} failed` +
  (broken > 0 ? `, ${broken} broken` : ''),
)
if (untallied.length > 0) {
  console.log(`suites with no readable tally: ${untallied.join(', ')}`)
}
if (!wantLive) {
  console.log('(the live suite was not run; pass --live to include it)')
}
process.exitCode = totalFailed > 0 || broken > 0 || untallied.length > 0 ? 1 : 0
