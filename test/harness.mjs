/**
 * Shared test bootstrap.
 *
 * Every suite resolves the plugin root from *this file's* location, so the
 * suites work from any checkout, any drive, and any clone path — no absolute
 * path is ever written into a test.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

/** The plugin root: `<repo>/` (this file lives in `<repo>/test/`). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A `require` anchored at the plugin root, for the plugin's own ESM files. */
export const require = createRequire(path.join(ROOT, 'package.json'))

/** Load a plugin module by its repo-relative path. */
export function load(relative) {
  return require(path.join(ROOT, relative))
}

/**
 * A tiny assertion harness.
 *
 * The suites print one line per check — a failing run is then readable
 * without a debugger, which matters because these suites are the evidence
 * for the host-safety guarantees and are meant to be run by a human.
 */
export function harness() {
  let passed = 0
  let failed = 0
  const failures = []

  function record(name, error) {
    failed++
    failures.push({ name, message: error?.message ?? String(error) })
  }

  return {
    check(name, fn) {
      try {
        fn()
        passed++
      } catch (error) {
        record(name, error)
      }
    },
    async checkAsync(name, fn) {
      try {
        await fn()
        passed++
      } catch (error) {
        record(name, error)
      }
    },
    report(title) {
      console.log('')
      console.log(`${title}: ${passed} passed, ${failed} failed`)
      if (failed > 0) {
        console.log('')
        for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
        process.exitCode = 1
      }
      return failed
    },
    get passed() { return passed },
    get failed() { return failed },
  }
}

/**
 * A scratch data directory under the OS temp dir, removed on exit.
 *
 * The suites must never write into the plugin tree or into the user's real
 * ai-buddy data directory.
 */
export function scratchDir(name) {
  const dir = path.join(
    process.env.TEMP ?? process.env.TMP ?? '.',
    `ai-buddy-test-${name}-${process.pid}`,
  )
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })
  return dir
}
