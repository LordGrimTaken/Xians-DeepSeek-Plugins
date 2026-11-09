// Process-level timer guard regression test.
// A repeatedly failing interval must be contained and disabled; the process
// must stay alive rather than crash with an uncaught exception.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('process guard contains and disables a failing interval timer', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-guard-test-'))
  const guard = path.resolve(import.meta.dirname, '../host/process-guard.cjs')
  const script = [
    "let ticks = 0",
    "setInterval(() => { ticks += 1; throw new Error('boom from timer') }, 5)",
    "setTimeout(() => { console.log('STILL_ALIVE ' + ticks); process.exit(0) }, 250)",
  ].join(';')
  const result = spawnSync(process.execPath, ['-r', guard, '-e', script], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /STILL_ALIVE/)
  const log = readFileSync(path.join(home, 'logs', 'process-guard.log'), 'utf8')
  assert.match(log, /contained interval failure/)
  assert.match(log, /disabled repeatedly failing interval/)
  rmSync(home, { recursive: true, force: true })
})
