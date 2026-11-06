/**
 * Effective configuration: the shipped defaults, deep-merged with whatever the
 * profile's `cordis.patch.yml` row carries, then clamped.
 *
 * Deliberately schema-free (no @deepseek-ai/schemastery, no `Config` export in
 * the entry): a bundle that declares `Config` has its row validated by the
 * Loader, and a validation failure unmounts the plugin. This plugin must stay
 * mounted even with a stale or partial override row — a workbench that refuses
 * to load because one numeric knob is a string is worse than one that clamps.
 * The real values are re-read at runtime through the workbench's Settings tab.
 */

import os from 'node:os'
import path from 'node:path'
import { clampMs, asRecord, isNonEmptyString } from './util.js'

export const DEFAULT_CONFIG = {
  dataDir: '',
  enableWeb: true,
  executionLock: {
    timeoutMs: 30 * 60 * 1000,
    queueMaxWaitMs: 10 * 60 * 1000,
    maxQueueDepth: 16,
  },
  resume: {
    silentWindowMs: 15 * 1000,
    activeWindowMs: 2 * 60 * 60 * 1000,
    maxAutoResumesPerWindow: 5,
    windowMs: 60 * 60 * 1000,
    backoffMs: [30000, 60000, 120000, 180000],
    honorRetryAfter: true,
    maxRetryWallMs: 30 * 60 * 1000,
  },
  interruptLock: {
    failureThreshold: 3,
    stableWindowMs: 10 * 60 * 1000,
    maxTrialResumes: 1,
  },
  feed: {
    aiPostsPerMinute: 20,
    retention: 5000,
  },
  assets: {
    maxAssetBytes: 32 * 1024 * 1024,
    highRiskGlobs: ['**/预算*', '**/合同*', '**/*.final.*'],
  },
  checkpoints: {
    perConversationRetention: 200,
    briefInlineCount: 3,
  },
  /**
   * Team lifecycle.
   *
   * `autoSpawn` is **off by default**, and that default is a hard requirement,
   * not a convenience: enabling this plugin must not create AI conversations on
   * its own. A session is a real, billable conversation with a real model; a
   * plugin that opens nine of them the moment it is enabled spends the user's
   * quota without being asked.
   *
   * With `autoSpawn: false`, a seat is only brought to life when the human asks
   * for it — by initializing the team, by mentioning a member, or by waking one
   * from the team panel.
   */
  team: {
    autoSpawn: false,
    /**
     * Whether the leader's background watch may re-deliver a human `@mention`
     * to a member that was not running when it was posted. Off by default for
     * the same reason as `autoSpawn`: it starts conversations.
     */
    autoWakeMentions: false,
  },
}

function num(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function backoffLadder(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) return [...fallback]
  const ladder = value
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .map((v) => Math.floor(v))
  return ladder.length === 0 ? [...fallback] : ladder
}

/**
 * Merge `overrides` over the defaults. Never throws: every read falls back to
 * the shipped value and every number is clamped into its documented range.
 */
export function resolveConfig(overrides, env = process.env) {
  const src = asRecord(overrides)
  const d = DEFAULT_CONFIG
  const lock = asRecord(src.executionLock)
  const resume = asRecord(src.resume)
  const interrupt = asRecord(src.interruptLock)
  const feed = asRecord(src.feed)
  const assets = asRecord(src.assets)
  const checkpoints = asRecord(src.checkpoints)
  const team = asRecord(src.team)

  return {
    dataDir: typeof src.dataDir === 'string' ? src.dataDir : d.dataDir,
    enableWeb: bool(src.enableWeb, d.enableWeb),
    executionLock: {
      timeoutMs: clampMs(lock.timeoutMs ?? d.executionLock.timeoutMs, 60_000, 24 * 60 * 60 * 1000),
      queueMaxWaitMs: clampMs(lock.queueMaxWaitMs ?? d.executionLock.queueMaxWaitMs, 5_000, 24 * 60 * 60 * 1000),
      maxQueueDepth: num(lock.maxQueueDepth, d.executionLock.maxQueueDepth, 1, 512),
    },
    resume: {
      silentWindowMs: clampMs(resume.silentWindowMs ?? d.resume.silentWindowMs, 0, 10 * 60 * 1000),
      activeWindowMs: clampMs(resume.activeWindowMs ?? d.resume.activeWindowMs, 60_000, 30 * 24 * 60 * 60 * 1000),
      maxAutoResumesPerWindow: num(resume.maxAutoResumesPerWindow, d.resume.maxAutoResumesPerWindow, 0, 100),
      windowMs: clampMs(resume.windowMs ?? d.resume.windowMs, 60_000, 24 * 60 * 60 * 1000),
      backoffMs: backoffLadder(resume.backoffMs, d.resume.backoffMs),
      honorRetryAfter: bool(resume.honorRetryAfter, d.resume.honorRetryAfter),
      maxRetryWallMs: clampMs(resume.maxRetryWallMs ?? d.resume.maxRetryWallMs, 60_000, 24 * 60 * 60 * 1000),
    },
    interruptLock: {
      failureThreshold: num(interrupt.failureThreshold, d.interruptLock.failureThreshold, 1, 100),
      stableWindowMs: clampMs(interrupt.stableWindowMs ?? d.interruptLock.stableWindowMs, 10_000, 24 * 60 * 60 * 1000),
      maxTrialResumes: num(interrupt.maxTrialResumes, d.interruptLock.maxTrialResumes, 1, 10),
    },
    feed: {
      aiPostsPerMinute: num(feed.aiPostsPerMinute, d.feed.aiPostsPerMinute, 0, 600),
      retention: num(feed.retention, d.feed.retention, 100, 200000),
    },
    assets: {
      maxAssetBytes: num(assets.maxAssetBytes, d.assets.maxAssetBytes, 1024, 512 * 1024 * 1024),
      highRiskGlobs: Array.isArray(assets.highRiskGlobs)
        ? assets.highRiskGlobs.filter(isNonEmptyString)
        : [...d.assets.highRiskGlobs],
    },
    checkpoints: {
      perConversationRetention: num(
        checkpoints.perConversationRetention,
        d.checkpoints.perConversationRetention,
        10,
        10000,
      ),
      briefInlineCount: num(checkpoints.briefInlineCount, d.checkpoints.briefInlineCount, 1, 20),
    },
    team: {
      autoSpawn: bool(team.autoSpawn, d.team.autoSpawn),
      autoWakeMentions: bool(team.autoWakeMentions, d.team.autoWakeMentions),
    },
    _env: env,
  }
}

/** `<DSH_HOME>/ai-buddy`, or the configured directory resolved against DSH_HOME. */
export function dataDirOf(config, env = process.env) {
  const home = isNonEmptyString(env?.DSH_HOME) ? env.DSH_HOME : path.join(os.homedir(), '.dsh')
  const configured = isNonEmptyString(config?.dataDir) ? config.dataDir : ''
  if (configured === '') return path.join(home, 'ai-buddy')
  return path.isAbsolute(configured) ? configured : path.join(home, configured)
}
