// Guest-UI recovery command composition (fast single-round-trip recovery).
import test from 'node:test'
import assert from 'node:assert/strict'
import { guestRecoveryCommand } from '../host/emulator.js'

test('first recovery restarts Launcher and goes home in one shell command', () => {
  const command = guestRecoveryCommand(0)
  assert.match(command, /am force-stop com\.android\.launcher3/)
  assert.doesNotMatch(command, /systemui/)
  assert.match(command, /input keyevent KEYCODE_WAKEUP/)
  assert.match(command, /android\.intent\.category\.HOME/)
})

test('second recovery also restarts System UI', () => {
  const command = guestRecoveryCommand(1)
  assert.match(command, /am force-stop com\.android\.systemui/)
  assert.match(command, /am force-stop com\.android\.launcher3/)
  assert.match(command, /android\.intent\.category\.HOME/)
})
