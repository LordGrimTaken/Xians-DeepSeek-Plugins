import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleSystem, sampleMemory, resetCpuSample } from '../metrics.js';

test('memory sample reports consistent byte totals and a bounded percent', () => {
  const memory = sampleMemory();
  assert.ok(memory.totalBytes > 0);
  assert.ok(memory.freeBytes >= 0 && memory.freeBytes <= memory.totalBytes);
  assert.equal(memory.usedBytes, memory.totalBytes - memory.freeBytes);
  assert.ok(memory.usedPercent >= 0 && memory.usedPercent <= 100);
  assert.ok(memory.processRssBytes > 0);
  assert.ok(memory.processHeapUsedBytes > 0);
});

test('first system sample has no CPU window, later samples are bounded percentages', async () => {
  resetCpuSample();
  const first = sampleSystem();
  assert.equal(first.ok, true);
  assert.equal(first.cpu.percent, null);
  assert.ok(first.cpu.cores > 0);
  assert.ok(typeof first.uptimeSeconds === 'number' && first.uptimeSeconds >= 0);
  // burn a little CPU so the next delta window is non-empty
  const start = Date.now();
  while (Date.now() - start < 40) { /* spin */ }
  const second = sampleSystem();
  assert.ok(second.cpu.percent === null || (second.cpu.percent >= 0 && second.cpu.percent <= 100));
  assert.match(second.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('resetCpuSample discards the previous window', () => {
  sampleSystem();
  resetCpuSample();
  assert.equal(sampleSystem().cpu.percent, null);
});
