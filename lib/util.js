/**
 * Pure helpers. No Cordis, no Host services — unit-testable from plain Node.
 *
 * Every filesystem write here is atomic (tmp file + rename) because the JSON
 * files are the truth layer (§6 of the design brief): a crash must never leave
 * a half-written project that a later resume pass would read as real state.
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'

/** `<prefix>_<16 hex>` — the id shapes the contract fixes. */
export function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

export function nowIso() {
  return new Date().toISOString()
}

/** Hex digest of a Buffer or a UTF-8 string. */
export function sha256(input) {
  const hash = createHash('sha256')
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
  return hash.digest('hex')
}

/** Filesystem-safe, length-bounded name; `fallback` when nothing survives. */
export function slugify(text, fallback = 'item') {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug === '' ? fallback : slug
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function readAndParse(file, fallback) {
  try {
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

export function readJsonFile(file, fallback) {
  return readAndParse(file, fallback)
}

/**
 * Write JSON through `<file>.tmp` + rename.
 *
 * `renameSync` over an existing file is atomic on both NTFS and POSIX, so a
 * reader either sees the previous complete document or the next one — never a
 * truncated one. The tmp name carries the pid so two processes (a Host restart
 * overlapping a still-running old process) cannot clobber each other's tmp.
 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function readTextFile(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

/** Absolute file paths under `dir`, sorted, skipping the tmp files above. */
export function listFilesRecursive(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFilesRecursive(full, out)
    else if (!entry.name.endsWith('.tmp')) out.push(full)
  }
  return out.sort()
}

export function clampMs(ms, min, max) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * `since` accepts an ISO string, an epoch-millisecond number/string, or
 * undefined. Returns milliseconds since epoch, or 0 for "everything".
 */
export function parseSince(value) {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : 0
}

/** `Date.parse` that yields `null` instead of NaN. */
export function parseTimeOrNull(value) {
  if (!value) return null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** A plain JSON-safe record, or `{}` for anything else. */
export function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

export function asStringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v !== '') : []
}

export function fileExists(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
}

export function filesEqual(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/** Truncate to `max` characters on a word boundary where possible. */
export function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Minimal glob for the `highRiskGlobs` config: `**`, `*`, and literals. */
export function globToRegExp(pattern) {
  let out = '^'
  const text = String(pattern)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '*') {
      if (text[i + 1] === '*') {
        out += '.*'
        i++
        if (text[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExp(ch)
    }
  }
  return new RegExp(`${out}$`, 'u')
}

export function matchesAnyGlob(candidate, patterns) {
  return patterns.some((pattern) => {
    try {
      return globToRegExp(pattern).test(candidate)
    } catch {
      return false
    }
  })
}
