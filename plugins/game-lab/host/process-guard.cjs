'use strict'
/*
 * Process-level guard for the DSH host.
 *
 * Plugins run in the same Node process as the host. A timer callback that throws
 * synchronously (or returns a rejected promise) normally becomes an
 * uncaughtException and takes the whole host down. This preload wraps timers so
 * such failures are logged and contained. A timer that keeps failing is cleared
 * after repeated failures, so one broken plugin timer cannot crash-loop DSH.
 *
 * Loaded with:
 *   NODE_OPTIONS=--require /usr/local/lib/dsh-process-guard.cjs
 */

const fs = require('node:fs')
const path = require('node:path')

const home = process.env.DSH_HOME || '/var/lib/dsh/dsh-home'
const logDir = path.join(home, 'logs')
const logFile = path.join(logDir, 'process-guard.log')
const MAX_FAILURES = 5

try {
  fs.mkdirSync(logDir, { recursive: true })
} catch {
  // Logging is best-effort; the guard must not fail at startup.
}

function log(line) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Never throw from the guard itself.
  }
}

const original = {
  setTimeout: global.setTimeout,
  setInterval: global.setInterval,
  clearTimeout: global.clearTimeout,
  clearInterval: global.clearInterval,
}

const failures = new Map()
let nextTimerId = 1

function callSite() {
  const stack = new Error('timer guard').stack || ''
  const lines = stack.split('\n').slice(2) // drop Error + callSite
  const external = lines.filter((line) => !line.includes('dsh-process-guard.cjs'))
  return (external.slice(0, 4).join('\n') || lines.slice(0, 4).join('\n')).trim()
}

function failureKey(kind, source) {
  return `${kind}\n${source}`
}

function recordFailure(kind, source, error) {
  const key = failureKey(kind, source)
  const state = failures.get(key) || { count: 0, timer: null }
  state.count += 1
  failures.set(key, state)
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  log(`contained ${kind} failure #${state.count}: ${message}\n${source}`)
  if (kind === 'interval' && state.count >= MAX_FAILURES) {
    if (state.timer !== null) {
      try { original.clearInterval(state.timer) } catch { /* already gone */ }
      log(`disabled repeatedly failing interval after ${state.count} failures\n${source}`)
      state.timer = null
    }
  }
}

function wrapCallback(kind, callback, source) {
  return function guardedTimerCallback(...args) {
    try {
      const result = callback.apply(this, args)
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => recordFailure(kind, source, error))
      }
      return result
    } catch (error) {
      recordFailure(kind, source, error)
      return undefined
    }
  }
}

global.setInterval = function guardedSetInterval(callback, delay, ...args) {
  if (typeof callback !== 'function') return original.setInterval(callback, delay, ...args)
  const source = callSite()
  const timer = original.setInterval(wrapCallback('interval', callback, source), delay, ...args)
  const state = failures.get(failureKey('interval', source))
  if (state !== undefined) state.timer = timer
  else failures.set(failureKey('interval', source), { count: 0, timer })
  return timer
}

global.setTimeout = function guardedSetTimeout(callback, delay, ...args) {
  if (typeof callback !== 'function') return original.setTimeout(callback, delay, ...args)
  const source = callSite()
  return original.setTimeout(wrapCallback('timeout', callback, source), delay, ...args)
}

global.clearInterval = original.clearInterval
global.clearTimeout = original.clearTimeout

process.on('uncaughtException', (error) => {
  log(`contained uncaughtException: ${error && error.stack ? error.stack : String(error)}`)
})

process.on('unhandledRejection', (reason) => {
  log(`contained unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`)
})

log('process guard active')
