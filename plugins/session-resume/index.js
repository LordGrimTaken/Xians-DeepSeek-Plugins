/**
 * Session Resume — host-side crash recovery for agent sessions.
 *
 * The DSH host keeps every session in the same Node process. When that process
 * dies (crash, OOM kill, `systemctl restart`, host restart) an in-flight turn
 * dies with it: the session log keeps an open turn and nothing re-drives it when
 * the process comes back. This plugin closes that gap without moving sessions
 * out of the host process.
 *
 * How it works
 *  1. A `session/event` listener mirrors every session's turn boundary into a
 *     small ledger on disk (`openTurns[sessionId]`). turn/start opens an entry,
 *     turn/end closes it. The ledger survives the process.
 *  2. On a fresh host boot (detected by the host pid changing) the plugin waits
 *     `delaySeconds`, then builds candidates from the ledger PLUS a durable scan
 *     of sessions whose log changed recently (covers a crash before the ledger
 *     saw the turn, e.g. right after install). Every candidate is verified
 *     against the stored session log tail — a real open turn must still be there.
 *  3. Verified sessions are re-driven through `sessionController.prompt`, the
 *     same path a phone/browser client uses. The agent-loop resume path appends
 *     synthetic "interrupted" tool results and a turn/end first, so the model
 *     sees a balanced transcript plus a continuation instruction that tells it to
 *     verify external state before repeating side-effecting actions.
 *
 * Safety
 *  - `dryRun` logs candidates without prompting.
 *  - Sessions live in this process are never touched.
 *  - Subagent sessions are skipped (their parent owns them).
 *  - Stale entries (older than `maxAgeMinutes`) are dropped.
 *  - A circuit breaker stops recovery when the host restarted repeatedly, so a
 *    session that crashes the host cannot create a boot loop.
 *  - Every failure is caught and logged; recovery must never take the host down.
 *
 * Only Node builtins are imported, so a linked bundle needs no install step.
 */

import { open as openFile } from 'node:fs/promises'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

export const name = 'session-resume'

/** Wait for the session controller so recovery cannot race host boot. */
export const inject = ['sessionController']

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const TAIL_WINDOWS = [1 << 18, 1 << 20, 1 << 22, 1 << 24]
const ZSTD_FLUSH = { finishFlush: zlibConstants.ZSTD_e_flush }

const DEFAULT_CONTINUATION_TEXT = [
  '[host-restart] The DSH host process restarted at {time} and interrupted this session\'s running turn.',
  '',
  'Continue the work from where it stopped rather than starting over:',
  '- Some tool calls may not have completed; their outcomes are unknown. Check files, processes and git state before repeating any side-effecting action.',
  '- Do not repeat work that is already done.',
  '- If the task is finished, briefly summarise the final state instead of redoing it.',
].join('\n')

const DEFAULTS = {
  enabled: true,
  /** Log candidates but never prompt. */
  dryRun: false,
  /** Let the freshly restarted host finish booting before touching sessions. */
  delaySeconds: 10,
  /** Ignore interrupted turns older than this. */
  maxAgeMinutes: 120,
  /** Durable-scan fallback: how far back to look for recently changed logs. */
  scanDurableSessions: true,
  scanWindowMinutes: 120,
  maxScanSessions: 12,
  /** Hard cap per boot so a broken session cannot resume-churn. */
  maxResumesPerBoot: 10,
  /** Space out consecutive resumes so many sessions do not start at once. */
  staggerMs: 1500,
  /** Circuit breaker: skip recovery when the host booted too often. */
  circuitBreakerWindowMinutes: 15,
  circuitBreakerMaxBoots: 4,
  /** Give up on a session that has already been auto-resumed repeatedly. */
  maxAttemptsPerSession: 2,
  attemptWindowMinutes: 30,
  skipSubagentSessions: true,
  /** Override for tests / unusual layouts; defaults derive from DSH_HOME. */
  stateFile: '',
  logFile: '',
  continuationText: DEFAULT_CONTINUATION_TEXT,
}

/** State schema version; a mismatch resets the ledger instead of guessing. */
const STATE_VERSION = 2

function homeDir() {
  return process.env.DSH_HOME || process.env.HOME || '/var/lib/dsh/dsh-home'
}

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const base = homeDir()
  if (!cfg.stateFile) cfg.stateFile = path.join(base, 'cache', 'session-resume', 'state.json')
  if (!cfg.logFile) cfg.logFile = path.join(base, 'logs', 'session-resume.log')
  return cfg
}

function emptyState() {
  return {
    version: STATE_VERSION,
    hostPid: null,
    boots: [],
    openTurns: {},
    attempts: {},
    lastRun: null,
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function iso(ms) {
  return new Date(ms).toISOString()
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/**
 * Fold turn boundaries exactly like `interruptedTurnClosers` does: the last
 * unbalanced `turn/start` means the log ends inside a turn.
 */
export function tailTurnState(events) {
  let openTurn = null
  let openStep = null
  let lastEventTime = 0
  let lastType = null
  for (const event of events) {
    if (typeof event?.time === 'number') lastEventTime = event.time
    lastType = event?.type ?? lastType
    switch (event?.type) {
      case 'turn/start':
        openTurn = event.data?.turn ?? 0
        openStep = null
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        break
      case 'step/start':
        openStep = event.data?.step ?? 0
        break
      case 'step/end':
        openStep = null
        break
      default:
        break
    }
  }
  return {
    open: openTurn !== null,
    turn: openTurn,
    openStep,
    lastEventTime,
    lastType,
    eventCount: events.length,
  }
}

/** Parse newline-delimited JSON; a torn trailing fragment fails the whole slice. */
function parseJsonl(text) {
  const lines = text.split('\n')
  const events = []
  for (const line of lines) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      return null
    }
  }
  return events.length > 0 ? events : null
}

const hasTurnBoundary = (events) => events.some((e) => e?.type === 'turn/start' || e?.type === 'turn/end')

/** Decode the JSONL frames that start at the earliest real boundary in `buffer`. */
function decodeFramedTail(buffer) {
  let at = 0
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    for (const options of [undefined, ZSTD_FLUSH]) {
      try {
        const events = parseJsonl(zstdDecompressSync(buffer.subarray(at), options).toString('utf8'))
        if (events !== null) return events
      } catch {
        // Not a frame boundary (or a torn frame): try the next candidate.
      }
    }
    at += 1
  }
  return null
}

/**
 * Read only the tail of one stored session log (zstd frame container or plain
 * JSONL) and return the turn state. Widens the window until a turn boundary is
 * visible or the whole file has been read.
 */
export async function readTailTurnState(filePath) {
  const handle = await openFile(filePath, 'r')
  try {
    const { size } = await handle.stat()
    if (size === 0) return null
    const zstd = filePath.endsWith('.zstd')
    let buffer = null
    for (const window of [...TAIL_WINDOWS, Number.POSITIVE_INFINITY]) {
      const start = Math.max(0, size - window)
      const fromStart = start === 0
      buffer = Buffer.alloc(size - start)
      await handle.read(buffer, 0, buffer.length, start)
      const events = zstd ? decodeFramedTail(buffer) : parseJsonl(buffer.toString('utf8'))
      if (events !== null && (fromStart || hasTurnBoundary(events))) {
        return tailTurnState(events.filter((e) => e?.type !== 'session'))
      }
      if (fromStart) break
    }
    return null
  } finally {
    await handle.close()
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const state = emptyState()
  let disposed = false
  let persistChain = Promise.resolve()
  let dirty = false
  let persistTimer = null
  let lastPersistAt = 0

  // ------------------------------------------------------------------ logging
  function log(message) {
    const line = `${new Date().toISOString()} ${message}`
    try {
      console.log(`[session-resume] ${message}`)
    } catch {
      // console may be gone during shutdown; the file log is the record.
    }
    appendFile(cfg.logFile, `${line}\n`).catch(() => {})
  }

  // ------------------------------------------------------------------- state
  async function loadState() {
    try {
      const raw = await readFile(cfg.stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (!isRecord(parsed) || parsed.version !== STATE_VERSION) {
        log(`ignoring incompatible state file version ${String(parsed?.version)}`)
        return
      }
      state.hostPid = typeof parsed.hostPid === 'number' ? parsed.hostPid : null
      state.boots = Array.isArray(parsed.boots) ? parsed.boots.filter((n) => typeof n === 'number') : []
      state.openTurns = isRecord(parsed.openTurns) ? parsed.openTurns : {}
      state.attempts = isRecord(parsed.attempts) ? parsed.attempts : {}
      state.lastRun = isRecord(parsed.lastRun) ? parsed.lastRun : null
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`state load failed: ${String(error)}`)
    }
  }

  function persistNow() {
    if (!dirty) return persistChain
    dirty = false
    lastPersistAt = Date.now()
    const snapshot = JSON.stringify(state)
    persistChain = persistChain
      .then(async () => {
        await mkdir(path.dirname(cfg.stateFile), { recursive: true })
        const tmp = `${cfg.stateFile}.${process.pid}.tmp`
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, cfg.stateFile)
      })
      .catch((error) => log(`state persist failed: ${String(error)}`))
    return persistChain
  }

  function markDirty({ immediate = false } = {}) {
    dirty = true
    if (immediate) {
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      void persistNow()
      return
    }
    if (persistTimer !== null) return
    const wait = Math.max(1000, 5000 - (Date.now() - lastPersistAt))
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistNow()
    }, wait)
    persistTimer.unref?.()
  }

  // ------------------------------------------------------------- turn ledger
  function recordEvent(session, event) {
    if (disposed || !session?.id || !event?.type) return
    const id = session.id
    if (event.type === 'turn/start') {
      state.openTurns[id] = {
        open: true,
        turn: event.data?.turn ?? null,
        startedAt: event.time ?? Date.now(),
        lastEventAt: event.time ?? Date.now(),
        cwd: session.header?.cwd ?? null,
        origin: session.header?.origin ?? null,
      }
      markDirty({ immediate: true })
      return
    }
    if (event.type === 'turn/end') {
      if (state.openTurns[id] !== undefined) {
        delete state.openTurns[id]
        markDirty({ immediate: true })
      }
      return
    }
    const entry = state.openTurns[id]
    if (entry !== undefined) {
      entry.lastEventAt = event.time ?? Date.now()
      markDirty()
    }
  }

  // -------------------------------------------------------------- recovery
  // Only a live Agent means work is actually running. A cold session that a
  // client merely opened stays resumable; the session controller dedupes the
  // resume (`session/writer-held` is swallowed by the caller).
  function isLiveSession(id) {
    try {
      if (ctx.get('agents')?.get?.(id) !== undefined) return true
    } catch {
      // A missing service means no live session for that key.
    }
    return false
  }

  /**
   * Verify one session against its stored log. Prefers a tail read of the
   * backend artifact (cheap even for large sessions) and falls back to the full
   * persistence read when no artifact location is available.
   */
  async function readStoredTail(id) {
    let persistence
    try {
      persistence = ctx.get('sessionPersistence')
    } catch {
      persistence = undefined
    }
    if (persistence === undefined || persistence === null) return null
    try {
      const snapshot = await persistence.stat(id)
      const location = snapshot?.location?.path
      if (typeof location === 'string' && location !== '') {
        const tail = await readTailTurnState(location)
        if (tail !== null) return { tail, header: snapshot.header, formatStatus: snapshot.formatStatus }
      }
    } catch (error) {
      log(`stat failed for ${id}: ${String(error)}`)
    }
    let handle
    try {
      handle = await persistence.open(id, 'read')
      const read = await handle.read(0)
      return { tail: tailTurnState(read?.events ?? []), header: handle.header }
    } catch (error) {
      log(`raw read failed for ${id}: ${String(error)}`)
      return null
    } finally {
      try {
        await handle?.close?.()
      } catch {
        // best-effort close
      }
    }
  }

  /** Sessions on disk whose log changed recently enough to be worth checking. */
  async function recentSessions(now, excludeIds) {
    if (!cfg.scanDurableSessions) return []
    let listed
    try {
      listed = await ctx.get('sessionController').list({}, AbortSignal.timeout(30_000))
    } catch (error) {
      log(`session list failed: ${String(error)}`)
      return []
    }
    const items = Array.isArray(listed?.items) ? listed.items : []
    const cutoff = now - cfg.scanWindowMinutes * 60_000
    return items
      .filter((item) => isRecord(item))
      .filter((item) => typeof item.sessionId === 'string' && !excludeIds.has(item.sessionId))
      .filter((item) => typeof item.updatedAt === 'number' && item.updatedAt >= cutoff)
      .filter((item) => item.running !== true)
      .filter((item) => item.formatStatus === undefined || item.formatStatus === 'current')
      .filter((item) => !(cfg.skipSubagentSessions && item.origin === 'subagent'))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, cfg.maxScanSessions))
  }

  function countRecent(list, since) {
    return (Array.isArray(list) ? list : []).filter((n) => typeof n === 'number' && n >= since).length
  }

  function attemptsFor(id, since) {
    return countRecent(state.attempts[id], since)
  }

  function rememberAttempt(id, at) {
    const since = at - cfg.attemptWindowMinutes * 60_000
    const kept = (Array.isArray(state.attempts[id]) ? state.attempts[id] : []).filter((n) => n >= since)
    kept.push(at)
    state.attempts[id] = kept.slice(-5)
  }

  function buildPromptText(when) {
    return String(cfg.continuationText).replaceAll('{time}', iso(when))
  }

  async function resumeSession(id, when) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('resume prompt timed out')), 30_000)
    timeout.unref?.()
    try {
      const requestId = `req_hostrestart_${randomUUID().replaceAll('-', '').slice(0, 24)}`
      await ctx.get('sessionController').prompt(
        {
          requestId,
          sessionId: id,
          mode: 'queue',
          content: [{ type: 'text', text: buildPromptText(when) }],
          clientTimeZone: 'UTC',
        },
        controller.signal,
      )
      return { ok: true, requestId }
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Shared admission checks; returns {resume:true, tail} when a session should be re-driven. */
  async function admitCandidate(id, entry, now) {
    if (isLiveSession(id)) {
      log(`skip ${id}: session is already live in this process`)
      return null
    }
    const attemptWindow = now - cfg.attemptWindowMinutes * 60_000
    if (attemptsFor(id, attemptWindow) >= cfg.maxAttemptsPerSession) {
      log(`skip ${id}: already auto-resumed ${cfg.maxAttemptsPerSession}x in ${cfg.attemptWindowMinutes}m`)
      return null
    }
    const stored = await readStoredTail(id)
    if (stored === null) {
      log(`skip ${id}: durable session log unavailable; cannot verify`)
      return null
    }
    if (cfg.skipSubagentSessions && stored.header?.origin === 'subagent') {
      log(`skip ${id}: subagent session (durable header)`)
      return null
    }
    if (stored.formatStatus !== undefined && stored.formatStatus !== 'current') {
      log(`skip ${id}: session format needs migration (${stored.formatStatus})`)
      return null
    }
    if (!stored.tail.open) {
      log(`skip ${id}: durable log is balanced (last=${String(stored.tail.lastType)}); nothing to resume`)
      return null
    }
    const ageMinutes = stored.tail.lastEventTime ? (now - stored.tail.lastEventTime) / 60_000 : Number.POSITIVE_INFINITY
    if (!(ageMinutes <= cfg.maxAgeMinutes)) {
      log(`skip ${id}: interrupted ${Math.round(ageMinutes)}m ago (limit ${cfg.maxAgeMinutes}m)`)
      return null
    }
    return { tail: stored.tail }
  }

  async function recoverInterruptedSessions() {
    const now = Date.now()
    const windowStart = now - cfg.circuitBreakerWindowMinutes * 60_000
    const recentBoots = countRecent(state.boots.slice(0, -1), windowStart)
    if (recentBoots >= cfg.circuitBreakerMaxBoots) {
      log(`circuit breaker: ${recentBoots} host boots in the last ${cfg.circuitBreakerWindowMinutes}m; skipping auto-resume`)
      return
    }

    // 1. Ledger candidates: turns this plugin watched start but never saw end.
    const ledgerIds = Object.keys(state.openTurns)
    const considered = new Set(ledgerIds)
    let scanned = 0
    let resumed = 0
    log(`ledger: ${ledgerIds.length} candidate(s)`)

    for (const id of ledgerIds) {
      const entry = state.openTurns[id]
      if (!isRecord(entry)) {
        delete state.openTurns[id]
        markDirty()
        continue
      }
      if (entry.origin === 'subagent' && cfg.skipSubagentSessions) {
        log(`skip ${id}: subagent session`)
        delete state.openTurns[id]
        markDirty()
        continue
      }
      if (resumed >= cfg.maxResumesPerBoot) {
        log(`cap reached (${cfg.maxResumesPerBoot}); leaving remaining candidates for the next boot`)
        break
      }
      const admitted = await admitCandidate(id, entry, now)
      if (admitted === null) {
        delete state.openTurns[id]
        continue
      }
      if (cfg.dryRun) {
        log(`dry run: would resume ${id} (turn ${String(admitted.tail.turn)}, open since ${iso(admitted.tail.lastEventTime)})`)
        continue
      }
      rememberAttempt(id, now)
      try {
        const result = await resumeSession(id, admitted.tail.lastEventTime || now)
        resumed += 1
        log(`resumed ${id}: turn ${String(admitted.tail.turn)} interrupted at ${iso(admitted.tail.lastEventTime)}; prompt ${result.requestId}`)
        delete state.openTurns[id]
        await sleep(cfg.staggerMs)
      } catch (error) {
        log(`resume failed for ${id}: ${String(error)}`)
      }
      markDirty({ immediate: true })
    }

    // 2. Durable-scan fallback: a crash can happen before the ledger ever saw
    //    the turn (e.g. the first crash after installing this plugin).
    const recent = await recentSessions(now, considered)
    if (recent.length > 0) log(`durable scan: ${recent.length} recent session(s) to verify`)
    for (const item of recent) {
      if (resumed >= cfg.maxResumesPerBoot) {
        log(`cap reached (${cfg.maxResumesPerBoot}); leaving remaining candidates for the next boot`)
        break
      }
      const id = item.sessionId
      scanned += 1
      const admitted = await admitCandidate(id, null, now)
      if (admitted === null) continue
      if (cfg.dryRun) {
        log(`dry run: would resume ${id} from durable scan (turn ${String(admitted.tail.turn)}, open since ${iso(admitted.tail.lastEventTime)})`)
        continue
      }
      rememberAttempt(id, now)
      try {
        const result = await resumeSession(id, admitted.tail.lastEventTime || now)
        resumed += 1
        log(`resumed ${id} from durable scan: turn ${String(admitted.tail.turn)} interrupted at ${iso(admitted.tail.lastEventTime)}; prompt ${result.requestId}`)
        await sleep(cfg.staggerMs)
      } catch (error) {
        log(`resume failed for ${id} (durable scan): ${String(error)}`)
      }
      markDirty({ immediate: true })
    }

    state.lastRun = { at: now, ledgerCandidates: ledgerIds.length, scanned, resumed }
    markDirty({ immediate: true })
    await persistNow()
  }

  // ------------------------------------------------------------------ boot
  function noteBoot() {
    const pid = process.pid
    if (state.hostPid === pid) {
      log('plugin reloaded inside the running host; no boot recorded')
      return { newBoot: false }
    }
    const windowStart = Date.now() - cfg.circuitBreakerWindowMinutes * 60_000
    state.hostPid = pid
    state.boots = state.boots.filter((n) => n >= windowStart).slice(-20)
    state.boots.push(Date.now())
    state.lastRun = null
    log(`host boot recorded (pid ${pid}, ${state.boots.length} boot(s) in window, ${Object.keys(state.openTurns).length} open turn(s) in ledger)`)
    markDirty({ immediate: true })
    return { newBoot: true }
  }

  async function start() {
    if (!cfg.enabled) {
      log('disabled by configuration; not starting')
      return
    }
    await mkdir(path.dirname(cfg.stateFile), { recursive: true }).catch(() => {})
    await loadState()
    const { newBoot } = noteBoot()
    if (!newBoot) {
      // A live plugin reload must not re-drive anything.
      return
    }
    log(`recovery scheduled in ${cfg.delaySeconds}s`)
    const timer = setTimeout(() => {
      if (disposed) return
      recoverInterruptedSessions().catch((error) => log(`recovery pass failed: ${String(error)}`))
    }, Math.max(0, cfg.delaySeconds) * 1000)
    timer.unref?.()
  }

  // ------------------------------------------------------------- observers
  ctx.on('session/event', (session, event) => recordEvent(session, event))

  ctx.effect(() => () => {
    disposed = true
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    dirty = true
    void persistNow()
    log('disposed')
  })

  start().catch((error) => log(`start failed: ${String(error)}`))
}
