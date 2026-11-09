/**
 * Pure host-side CPU/memory sampling for the system-monitor plugin.
 *
 * CPU usage is a delta between two os.cpus() time samples, so the first read returns
 * `cpuPercent: null` and later reads (polled by the browser every few seconds) report the
 * average across the window. Memory comes straight from os.*mem, with the Harness host
 * process's own heap/RSS reported separately.
 */
import os from 'node:os';

/** Previous aggregate CPU-time sample; module-local so one poll window spans requests. */
let previousCpuSample = null;

/** Sum idle and total CPU jiffies across all cores. */
function readCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, cores: cpus.length, at: Date.now() };
}

/** CPU usage since the previous sample, or null when there is no usable window yet. */
export function sampleCpuPercent(now = readCpuTimes()) {
  const previous = previousCpuSample;
  previousCpuSample = now;
  if (previous === null || now.at <= previous.at) return null;
  const totalDelta = now.total - previous.total;
  const idleDelta = now.idle - previous.idle;
  if (!(totalDelta > 0) || idleDelta < 0 || idleDelta > totalDelta) return null;
  const used = (totalDelta - idleDelta) / totalDelta;
  return Math.round(used * 1000) / 10;
}

/** Memory figures in bytes plus the process's own footprint. */
export function sampleMemory() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usage = process.memoryUsage();
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
    processRssBytes: usage.rss,
    processHeapUsedBytes: usage.heapUsed,
  };
}

/** Complete sample served by GET /system-monitor. `cpu.percent` is null on the first call. */
export function sampleSystem() {
  const cpuTimes = readCpuTimes();
  const cpuPercent = sampleCpuPercent(cpuTimes);
  return {
    ok: true,
    sampledAt: new Date().toISOString(),
    platform: os.platform(),
    release: os.release(),
    uptimeSeconds: Math.round(os.uptime()),
    cpu: {
      percent: cpuPercent,
      cores: cpuTimes.cores,
      model: os.cpus()[0]?.model ?? '',
      // os.loadavg() is all zeros on Windows; the client only shows it where meaningful.
      loadavg: os.loadavg(),
    },
    memory: sampleMemory(),
  };
}

/** Reset the CPU window (tests). */
export function resetCpuSample() {
  previousCpuSample = null;
}
