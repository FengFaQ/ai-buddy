/**
 * The one place AI Buddy creates a message or hands one to the Host.
 *
 * This module lives in `lib/core/` because it is pure: it has no Cordis
 * dependency, so both the Host-facing runtime (`lib/host/`) and the recovery
 * subsystem (`lib/core/resume.js`) can use it without inverting the layering.
 *
 * ## Why this module exists
 *
 * Two Host crashes in this environment traced back to one mistake: handing the
 * Host a message it could not key. The Host's durable inbox is a *set* keyed by
 * `message.id`:
 *
 *   - `dsh-agent-loop/lib/index.js` `ReactLoopInbox.mutate` throws
 *     `message "<id>" is already pending` when a pending id repeats;
 *   - `dsh-session/lib/index.js` `assertMessageEventShape` throws
 *     `<subject> lacks an identified message` when a stored `user/message` has
 *     no `id` — which marks the whole session file unreadable.
 *
 * Both throws happen **inside the Host**, past the plugin's own try/catch, so
 * they are not plugin errors: they take the whole Host process down. A resume
 * or a @-mention must never be able to do that.
 *
 * ## The rules this module enforces
 *
 * 1. **Every message has a non-empty string `id`.** Generated here, never
 *    assumed from a caller.
 * 2. **Every message has the shape the Host's session validator demands**
 *    (`role`, `content` array, `source.kind`), so a stored session stays
 *    readable after a restart.
 * 3. **Every id is unique per conversation.** The Host rejects a repeated id
 *    across the two pending lists, so ids are minted per conversation and
 *    tracked; a collision is impossible by construction rather than by luck.
 * 4. **Delivery never throws into the Host.** `followup` / `steer` / `inject`
 *    are called inside a guard that converts a fault into a normal result, and
 *    the caller always sees a resolved promise.
 *
 * ## Transport choice
 *
 * `dsh-connect-workbuddy` (the WorkBuddy connector) never calls
 * `agent.followup()` for anything it delivers; it uses `agent.steer()` when the
 * agent is idle and `agent.inject()` otherwise
 * (`src/cli-bridge/inject.ts:218-220`), because `followup` "撞上宿主自己的收尾动作"
 * — collides with the Host's own teardown. AI Buddy adopts the same rule:
 *
 *   - `followup` starts a *new turn* (`next-turn`),
 *   - `steer` cuts into the *current* turn (`next-step`) and wakes the driver,
 *   - `inject` queues context for the next step boundary *without* waking.
 *
 * A team member that is already working should be *steered*, not given a
 * competing turn; a member that is idle should be *followed up* to start one.
 */

import { randomUUID } from 'node:crypto'

/**
 * The Host's `user/message` shape.
 *
 * Mirrors `@deepseek-ai/dsh-llm`'s `createUserMessage`, which this plugin
 * cannot import: the bundled host packages resolve from the DSH installation
 * (inside `app.asar`), not from the profile's `node_modules`, so a profile
 * plugin has no import path to them. The shape below is the one the Host's own
 * `createUserMessage` produces, and the one the Host's session validator
 * (`dsh-session`, `assertMessageEventShape`) demands:
 *
 *   - `id`      — non-empty string (the inbox key and the session-log identity);
 *   - `role`    — `'user'`;
 *   - `content` — an array of content blocks;
 *   - `source`  — an object with a non-empty `kind` string.
 *
 * ## Why `source` is exactly `{ kind: 'user' }`
 *
 * The `user` source kind has a **closed** shape. The Host's own session
 * controller — the reference implementation for delivering a message to an
 * agent — builds exactly this:
 *
 *   ```js
 *   const source = { kind: "user", rpcId: request.requestId, ...clientTimeZone, ...principal }
 *   const message = createUserMessage({ content, source })
 *   ```
 *
 * and the session-format rules accept only `kind` plus the optional `rpcId` /
 * `clientTimeZone` / `principal`. `form` and `summary` are **not** members of
 * the `user` kind (they belong to the `plugin` kind, which pairs `form:
 * 'notice'` with a `summary`).
 *
 * An earlier revision of this plugin wrote `{ kind: 'user', form: 'notice',
 * summary: … }`. It happened to survive the *live* validator — which only
 * checks that `source.kind` is a non-empty string — but it is off-contract,
 * and it is rejected by the session-format rules. The label is kept out of
 * `source` for that reason: AI Buddy records the origin in its own feed, which
 * is the durable place for it, and the Host's transcript does not need it.
 */
const MESSAGE_SOURCE = Object.freeze({ kind: 'user' })

/** Validate a candidate message against the Host's session-log requirements. */
function isDeliverableMessage(message) {
  if (message === null || typeof message !== 'object') return false
  if (typeof message.id !== 'string' || message.id === '') return false
  if (message.role !== 'user') return false
  if (!Array.isArray(message.content) || message.content.length === 0) return false
  const source = message.source
  if (source === null || typeof source !== 'object') return false
  if (typeof source.kind !== 'string' || source.kind === '') return false
  return true
}

/**
 * Mint one identified user message.
 *
 * @param {string} text        the message body (must be non-empty).
 * @param {string} [summary]   a short label describing the origin. It is
 *   **not** put on `source` — the `user` source kind has a closed shape and
 *   does not carry a summary (see the note above). The label is still
 *   accepted, because callers use it for logging, and it is returned
 *   alongside the message for that purpose.
 * @param {string} [messageId] an explicit identity; used by tests and by
 *   retry paths that must reuse the *same* identity. Omit in normal use.
 * @returns {{id: string, role: 'user', content: object[], source: object}}
 */
export function createUserMessage(text, summary, messageId) {
  const body = typeof text === 'string' ? text : ''
  if (body === '') throw new TypeError('createUserMessage: text must be a non-empty string')
  return {
    id: typeof messageId === 'string' && messageId !== '' ? messageId : randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { ...MESSAGE_SOURCE },
  }
}

/**
 * A per-conversation ledger of message ids already delivered.
 *
 * The Host keeps pending input in two lists (`next-turn`, `next-step`) and
 * rejects a splice whose ids repeat across the union of both. AI Buddy
 * delivers into both, so the plugin must never mint the same id twice for one
 * conversation — otherwise the Host throws inside the agent loop and the
 * process dies.
 *
 * The ledger is a `Set` of ids, bounded so a long-lived session cannot grow it
 * without limit. Entries are dropped only after they can no longer be pending:
 * the Host consumes a pending message when it claims the turn, and the plugin
 * only ever learns that a delivery succeeded, not when the message was
 * consumed. So the ledger is a *recent-history* guard rather than an exact
 * one — but ids are UUID v4, so an accidental collision is already
 * astronomically unlikely; the ledger turns "unlikely" into "impossible" for
 * the realistic failure mode (one code path minting twice).
 */
export class MessageLedger {
  /**
   * @param {number} [capacity] maximum number of ids remembered per
   *   conversation. Older ids are forgotten first.
   */
  constructor(capacity = 512) {
    this.capacity = Math.max(16, Number(capacity) || 512)
    /** @type {Map<string, Set<string>>} */
    this.ids = new Map()
  }

  /** Whether an id was already used for this conversation. */
  has(conversationId, messageId) {
    const set = this.ids.get(String(conversationId))
    return set !== undefined && set.has(String(messageId))
  }

  /** Remember an id for this conversation. Returns false if it was a repeat. */
  remember(conversationId, messageId) {
    const key = String(conversationId)
    let set = this.ids.get(key)
    if (set === undefined) {
      set = new Set()
      this.ids.set(key, set)
    }
    if (set.has(String(messageId))) return false
    set.add(String(messageId))
    if (set.size > this.capacity) {
      // Sets iterate in insertion order, so the first entry is the oldest.
      const oldest = set.values().next().value
      set.delete(oldest)
    }
    return true
  }

  /** Forget every id of one conversation (e.g. the conversation was disposed). */
  forget(conversationId) {
    this.ids.delete(String(conversationId))
  }

  /** Forget every conversation. */
  clear() {
    this.ids.clear()
  }
}

/**
 * Deliver one message into a live agent, without ever throwing.
 *
 * The transport depends on what the agent is doing:
 *
 *   - **idle** → `followup`: open a new turn. This is what "ask this member to
 *     work" means.
 *   - **running** → `steer`: cut into the turn in progress at its next step
 *     boundary, and wake the driver. A second `followup` here would open a
 *     *competing* turn (the Host's own comment on `followup`: "再 followup 会
 *     变成两条并行的意图"), so steering is the correct transport.
 *
 * `inject` (queue without waking) is deliberately **not** used for human-facing
 * messages: a message that does not wake the driver would sit in the inbox
 * until the agent happened to take another step, which is exactly the "@ does
 * nothing" symptom this plugin exists to fix. It remains the right choice for
 * context that must not start work.
 *
 * @param {object} agent       the live agent.
 * @param {object} message     an identified user message.
 * @param {object} [options]   `{ transport: 'auto'|'followup'|'steer'|'inject' }`.
 * @returns {Promise<{delivered: boolean, transport: string, reason?: string}>}
 */
export async function deliver(agent, message, options = {}) {
  if (agent === null || typeof agent !== 'object') {
    return { delivered: false, transport: 'none', reason: 'no_agent' }
  }
  if (!isDeliverableMessage(message)) {
    return { delivered: false, transport: 'none', reason: 'invalid_message' }
  }

  const requested = options.transport ?? 'auto'
  const running = agent.status === 'running'
  const transport =
    requested === 'auto'
      ? (running ? 'steer' : 'followup')
      : requested

  const method = typeof agent[transport] === 'function' ? transport : 'followup'
  if (typeof agent[method] !== 'function') {
    return { delivered: false, transport: 'none', reason: 'no_transport' }
  }

  try {
    await agent[method](message)
    return { delivered: true, transport: method }
  } catch (error) {
    /**
     * The Host throws from *inside* the agent loop when a message cannot be
     * keyed (see the module header). That fault is not catchable by the Host
     * itself, but it IS catchable here — `followup`/`steer`/`inject` are
     * synchronous methods that splice into the inbox, so the throw surfaces
     * synchronously at the call site.
     *
     * Catching it here is the difference between "this member could not be
     * reached" and "DSH is gone".
     */
    return {
      delivered: false,
      transport: method,
      reason: 'delivery_failed',
      error: error?.message ?? String(error),
    }
  }
}

export { isDeliverableMessage }
