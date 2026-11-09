/**
 * Unit tests for the session-resume host plugin.
 *
 * Drives `apply()` through a fake Cordis context: fake `sessionController`,
 * fake `sessionPersistence`, and a controllable `session/event` bus, then
 * asserts the recovery pass through a real temp state file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { zstdCompressSync } from 'node:zlib'

import { apply, readTailTurnState, tailTurnState } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function turnStart(turn, time) {
  return { type: 'turn/start', seq: 1, time, data: { turn } }
}

function turnEnd(turn, time) {
  return { type: 'turn/end', seq: 2, time, data: { turn, reason: { kind: 'stopped' } } }
}

function makeCtx({ prompts, rawEvents = {}, liveIds = [], persistence = true, listItems = [], locations = {} }) {
  const handlers = new Map()
  const services = {
    sessionController: {
      prompt: async (request, signal) => {
        assert.ok(signal instanceof AbortSignal, 'prompt receives an AbortSignal')
        prompts.push(request)
        return { accepted: true }
      },
      list: async () => ({ items: listItems }),
    },
    agents: { get: (id) => (liveIds.includes(id) ? { id } : undefined) },
    sessions: { get: () => undefined },
  }
  if (persistence) {
    services.sessionPersistence = {
      stat: async (id) => ({
        header: { id, cwd: '/tmp/ws', origin: rawEvents[id]?.origin ?? null },
        location: locations[id] === undefined ? undefined : { kind: 'jsonl', path: locations[id] },
      }),
      open: async (id) => ({
        header: { id, cwd: '/tmp/ws', origin: rawEvents[id]?.origin ?? null },
        read: async () => ({ events: rawEvents[id]?.events ?? [] }),
        close: async () => {},
      }),
    }
  }
  const ctx = {
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
    },
    get(name) {
      return services[name]
    },
    effect(fn) {
      fn()
    },
    emit(name, ...args) {
      for (const fn of handlers.get(name) ?? []) fn(...args)
    },
  }
  return ctx
}

async function seedState(stateFile, partial) {
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 2,
      hostPid: process.pid + 1,
      boots: [],
      openTurns: {},
      attempts: {},
      lastRun: null,
      ...partial,
    }),
  )
}

async function readState(stateFile) {
  return JSON.parse(await readFile(stateFile, 'utf8'))
}

async function makeCase(name) {
  const dir = await mkdtemp(path.join(tmpdir(), `session-resume-${name}-`))
  return {
    dir,
    stateFile: path.join(dir, 'state.json'),
    logFile: path.join(dir, 'session-resume.log'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

test('fresh boot resumes a session whose durable turn is open', async () => {
  const c = await makeCase('resume')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-open': { open: true, turn: 3, lastEventAt: now - 60_000, origin: null } },
  })
  const rawEvents = { 'sess-open': { events: [turnStart(3, now - 60_000)] } }
  apply(makeCtx({ prompts, rawEvents }), { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 })
  await sleep(300)
  await c.cleanup()

  assert.equal(prompts.length, 1, 'one continuation prompt')
  assert.equal(prompts[0].sessionId, 'sess-open')
  assert.equal(prompts[0].mode, 'queue')
  assert.match(prompts[0].content[0].text, /host-restart/)
  assert.match(prompts[0].content[0].text, /outcomes are unknown/)
})

test('balanced durable log is left alone', async () => {
  const c = await makeCase('balanced')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-done': { open: true, turn: 2, lastEventAt: now - 30_000 } },
  })
  const rawEvents = { 'sess-done': { events: [turnStart(2, now - 30_000), turnEnd(2, now - 20_000)] } }
  apply(makeCtx({ prompts, rawEvents }), { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 })
  await sleep(300)
  const state = await readState(c.stateFile)
  await c.cleanup()

  assert.equal(prompts.length, 0)
  assert.equal(state.openTurns['sess-done'], undefined, 'stale entry cleared')
})

test('dry run never prompts', async () => {
  const c = await makeCase('dry')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-open': { open: true, turn: 1, lastEventAt: now - 10_000 } },
  })
  apply(makeCtx({ prompts, rawEvents: { 'sess-open': { events: [turnStart(1, now - 10_000)] } } }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
    dryRun: true,
  })
  await sleep(300)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 0)
  assert.match(log, /dry run: would resume sess-open/)
})

test('a live session is never re-driven', async () => {
  const c = await makeCase('live')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-live': { open: true, turn: 1, lastEventAt: now - 10_000 } },
  })
  apply(
    makeCtx({ prompts, liveIds: ['sess-live'], rawEvents: { 'sess-live': { events: [turnStart(1, now - 10_000)] } } }),
    { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 },
  )
  await sleep(300)
  await c.cleanup()

  assert.equal(prompts.length, 0)
})

test('interrupted turns older than maxAgeMinutes are dropped', async () => {
  const c = await makeCase('stale')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-old': { open: true, turn: 1, lastEventAt: now - 5 * 3_600_000 } },
  })
  apply(makeCtx({ prompts, rawEvents: { 'sess-old': { events: [turnStart(1, now - 5 * 3_600_000)] } } }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
    maxAgeMinutes: 120,
  })
  await sleep(300)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 0)
  assert.match(log, /skip sess-old: interrupted 300m ago/)
})

test('subagent sessions are skipped', async () => {
  const c = await makeCase('subagent')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-sub': { open: true, turn: 1, lastEventAt: now - 10_000, origin: 'subagent' } },
  })
  apply(makeCtx({ prompts }), { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 })
  await sleep(300)
  await c.cleanup()

  assert.equal(prompts.length, 0)
})

test('per-session attempt cap stops repeat resumes', async () => {
  const c = await makeCase('attempts')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-open': { open: true, turn: 1, lastEventAt: now - 10_000 } },
    attempts: { 'sess-open': [now - 2_000, now - 5_000] },
  })
  apply(makeCtx({ prompts, rawEvents: { 'sess-open': { events: [turnStart(1, now - 10_000)] } } }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
    maxAttemptsPerSession: 2,
  })
  await sleep(300)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 0)
  assert.match(log, /already auto-resumed 2x/)
})

test('circuit breaker stops recovery after repeated boots', async () => {
  const c = await makeCase('breaker')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    boots: [now - 60_000, now - 120_000, now - 180_000, now - 240_000],
    openTurns: { 'sess-open': { open: true, turn: 1, lastEventAt: now - 10_000 } },
  })
  apply(makeCtx({ prompts, rawEvents: { 'sess-open': { events: [turnStart(1, now - 10_000)] } } }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
    circuitBreakerMaxBoots: 4,
  })
  await sleep(300)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 0)
  assert.match(log, /circuit breaker/)
})

test('a plugin reload inside the same host does not re-drive sessions', async () => {
  const c = await makeCase('reload')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    hostPid: process.pid,
    openTurns: { 'sess-open': { open: true, turn: 1, lastEventAt: now - 10_000 } },
  })
  apply(makeCtx({ prompts, rawEvents: { 'sess-open': { events: [turnStart(1, now - 10_000)] } } }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
  })
  await sleep(300)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 0)
  assert.match(log, /reloaded inside the running host/)
})

test('without sessionPersistence a candidate is not resumed blindly', async () => {
  const c = await makeCase('nopersistence')
  const now = Date.now()
  const prompts = []
  await seedState(c.stateFile, {
    openTurns: { 'sess-open': { open: true, turn: 1, lastEventAt: now - 10_000 } },
  })
  apply(makeCtx({ prompts, persistence: false }), { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 })
  await sleep(200)
  await c.cleanup()

  assert.equal(prompts.length, 0)
})

test('turn events maintain the ledger', async () => {
  const c = await makeCase('ledger')
  const prompts = []
  const ctx = makeCtx({ prompts })
  ctx.effect = () => {}
  const now = Date.now()
  apply(ctx, { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 60_000 })
  await sleep(50)
  const session = { id: 'sess-ledger', header: { cwd: '/tmp/ws', origin: null } }
  ctx.emit('session/event', session, turnStart(7, now))
  await sleep(100)
  let state = await readState(c.stateFile)
  assert.equal(state.openTurns['sess-ledger']?.turn, 7)
  ctx.emit('session/event', session, turnEnd(7, now + 1000))
  await sleep(150)
  state = await readState(c.stateFile)
  await c.cleanup()
  assert.equal(state.openTurns['sess-ledger'], undefined)
})

test('one recovery pass resumes every open-turn candidate up to the cap', async () => {
  const c = await makeCase('multi')
  const now = Date.now()
  const prompts = []
  const openTurns = {}
  const rawEvents = {}
  for (const n of [1, 2, 3]) {
    const id = `sess-${n}`
    openTurns[id] = { open: true, turn: n, lastEventAt: now - n * 5_000 }
    rawEvents[id] = { events: [turnStart(n, now - n * 5_000)] }
  }
  await seedState(c.stateFile, { openTurns })
  apply(makeCtx({ prompts, rawEvents }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
    staggerMs: 0,
    maxResumesPerBoot: 10,
  })
  await sleep(400)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 3, 'all three interrupted sessions are resumed')
  assert.deepEqual(prompts.map((p) => p.sessionId).sort(), ['sess-1', 'sess-2', 'sess-3'])
  assert.equal((log.match(/resumed sess-/g) ?? []).length, 3)
  assert.doesNotMatch(log, /cap reached/)
})

test('the per-boot cap still bounds a mass resume', async () => {
  const c = await makeCase('cap')
  const now = Date.now()
  const prompts = []
  const openTurns = {}
  const rawEvents = {}
  for (const n of [1, 2, 3, 4]) {
    const id = `sess-${n}`
    openTurns[id] = { open: true, turn: n, lastEventAt: now - n * 5_000 }
    rawEvents[id] = { events: [turnStart(n, now - n * 5_000)] }
  }
  await seedState(c.stateFile, { openTurns })
  apply(makeCtx({ prompts, rawEvents }), {
    stateFile: c.stateFile,
    logFile: c.logFile,
    delaySeconds: 0,
    staggerMs: 0,
    maxResumesPerBoot: 2,
  })
  await sleep(400)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 2)
  assert.match(log, /cap reached \(2\)/)
})

test('durable scan finds an interrupted turn the ledger never saw', async () => {
  const c = await makeCase('scan')
  const now = Date.now()
  const prompts = []
  const logPath = path.join(c.dir, 'scan-session.jsonl')
  await writeFile(
    logPath,
    [
      JSON.stringify({ type: 'session', version: 4, id: 'sess-scan', cwd: '/tmp/ws' }),
      JSON.stringify({ type: 'turn/start', seq: 1, time: now - 15_000, data: { turn: 4 } }),
      JSON.stringify({ type: 'assistant/message', seq: 2, time: now - 10_000, data: { turn: 4, step: 1 } }),
    ].join('\n') + '\n',
  )
  const ctx = makeCtx({
    prompts,
    listItems: [{ sessionId: 'sess-scan', updatedAt: now - 10_000, running: false, origin: undefined }],
    locations: { 'sess-scan': logPath },
  })
  apply(ctx, { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 })
  await sleep(300)
  const log = await readFile(c.logFile, 'utf8')
  await c.cleanup()

  assert.equal(prompts.length, 1, 'scan fallback resumed the session')
  assert.equal(prompts[0].sessionId, 'sess-scan')
  assert.match(log, /resumed sess-scan from durable scan/)
})

test('durable scan ignores balanced, stale and subagent sessions', async () => {
  const c = await makeCase('scan-skip')
  const now = Date.now()
  const prompts = []
  const balanced = path.join(c.dir, 'balanced.jsonl')
  await writeFile(
    balanced,
    [
      JSON.stringify({ type: 'turn/start', seq: 1, time: now - 15_000, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: now - 10_000, data: { turn: 1 } }),
    ].join('\n') + '\n',
  )
  const ctx = makeCtx({
    prompts,
    listItems: [
      { sessionId: 'sess-balanced', updatedAt: now - 10_000, running: false },
      { sessionId: 'sess-sub', updatedAt: now - 10_000, running: false, origin: 'subagent' },
      { sessionId: 'sess-old', updatedAt: now - 5 * 3_600_000, running: false },
    ],
    locations: { 'sess-balanced': balanced },
  })
  apply(ctx, { stateFile: c.stateFile, logFile: c.logFile, delaySeconds: 0 })
  await sleep(300)
  await c.cleanup()

  assert.equal(prompts.length, 0)
})

test('readTailTurnState reads a zstd frame container', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'session-resume-zstd-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const now = Date.now()
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'sess-z', cwd: '/tmp/ws' }),
    JSON.stringify({ type: 'turn/start', seq: 1, time: now - 5_000, data: { turn: 9 } }),
    JSON.stringify({ type: 'tool/call', seq: 2, time: now - 1_000, data: { turn: 9, step: 1 } }),
  ]
  await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  const tail = await readTailTurnState(file)
  await rm(dir, { recursive: true, force: true })
  assert.equal(tail.open, true)
  assert.equal(tail.turn, 9)
  assert.equal(tail.lastType, 'tool/call')
})

test('tailTurnState matches the repair scan', () => {
  const now = Date.now()
  assert.equal(tailTurnState([]).open, false)
  assert.deepEqual(tailTurnState([turnStart(1, now)]), {
    open: true,
    turn: 1,
    openStep: null,
    lastEventTime: now,
    lastType: 'turn/start',
    eventCount: 1,
  })
  assert.equal(tailTurnState([turnStart(1, now), turnEnd(1, now)]).open, false)
  const nested = [turnStart(1, now), { type: 'step/start', seq: 2, time: now, data: { turn: 1, step: 1 } }]
  assert.equal(tailTurnState(nested).open, true)
  assert.equal(tailTurnState(nested).openStep, 1)
})
