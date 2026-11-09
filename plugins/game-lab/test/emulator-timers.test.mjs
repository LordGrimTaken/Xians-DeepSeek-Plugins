// Regression test: begin() must never throw while its periodic ticks run.
//
// The original crash was caused by synchronous tick methods (#tickFrames and
// #tickVideo) being used with `.catch(...)`; they returned `undefined`, so the
// timer threw "Cannot read properties of undefined (reading 'catch')" and took
// the whole DSH host down. This test starts the real timer set (with the SDK
// lookup made inert) and lets every tick callback run at least once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GameLab } from '../host/emulator.js'

test('begin() starts all ticks without throwing on non-promise tick results', async () => {
  const lab = new GameLab({}, { avdName: 'timer-test', gameRoots: [] })
  // Make toolchain-dependent work inert; begin() must still be safe.
  lab.toolchain = { ok: false, reason: 'intentionally inert for begin() test' }

  assert.doesNotThrow(() => lab.begin())
  assert.equal(lab.timers.length, 7)

  // Let the initial #tickResources()/#listAvds() and one tick fire. If a
  // synchronous tick were passed to .catch, this would surface as an
  // uncaught exception instead of a rejected-then-caught promise.
  await new Promise((resolve) => setTimeout(resolve, 40))
  await lab.dispose()
  assert.equal(lab.timers.length, 0)
})
