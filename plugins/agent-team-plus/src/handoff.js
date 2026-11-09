/**
 * Atomic, collision-resistant handoff artifact writes.
 *
 * A handoff is the evidence that unlocks completing a shared task, so a process interruption must
 * never leave a partial `.md` that looks like a valid handoff. The artifact is written to a private
 * temporary file and renamed into place; the final name includes a timestamp, a sanitized member name,
 * and a random nonce so two handoffs in the same millisecond cannot overwrite each other.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './fs-atomic.js';

const HANDOFF_TITLE = '# Team handoff — ';
const DEFAULT_HANDOFF_MAX_AGE_MS = 30 * 60_000;
export const DEFAULT_HANDOFF_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;

/** Retention window from the environment; null disables archival. Invalid values fall back to 90 days. */
export function handoffRetentionMs(env = process.env) {
  const raw = env?.DSH_TEAM_HANDOFF_RETENTION_DAYS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_HANDOFF_RETENTION_DAYS * DAY_MS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 3650) return DEFAULT_HANDOFF_RETENTION_DAYS * DAY_MS;
  return days === 0 ? null : days * DAY_MS;
}

/** Produce a filesystem-safe member fragment for the artifact name. */
export function safeMemberFragment(memberName) {
  const value = String(memberName ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64);
  return value === '' ? 'member' : value;
}

/** Build the final artifact filename. `nonce` is injectable for deterministic tests. */
export function handoffFileName(memberName, { now = Date.now(), nonce = randomUUID() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${safeMemberFragment(memberName)}-${nonce}.md`;
}

/**
 * Find the newest existing handoff artifact for a teammate. Used after a host restart so a
 * cold-resumed teammate can rely on a recent artifact instead of being forced to re-handoff.
 * Artifact titles are written by renderHandoff() and are matched exactly.
 */
export async function findHandoffArtifacts(dir, memberName, { now = Date.now(), maxAgeMs = DEFAULT_HANDOFF_MAX_AGE_MS } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await fs.stat(file);
      if (info.size > 1_000_000) continue;
      if (now - info.mtimeMs > maxAgeMs) continue;
      const text = await fs.readFile(file, 'utf8');
      const firstLine = text.split('\n', 1)[0];
      if (firstLine !== HANDOFF_TITLE + String(memberName)) continue;
      const task = /^- task: (.+)$/m.exec(text);
      const value = task === null ? '(not specified)' : task[1].trim();
      found.push({ file, at: info.mtimeMs, taskId: ['(not specified)', '(none)', ''].includes(value) ? null : value });
    } catch {
      // Ignore unreadable/racing artifacts; another may be valid.
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found;
}

/**
 * Remove abandoned hidden temporary files left by an interrupted handoff write. Only files matching
 * this module's temp-name shape and older than `maxAgeMs` are touched.
 */
export async function cleanupStaleHandoffTemps(dir, { now = Date.now(), maxAgeMs = 60 * 60_000 } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^\..+\.[0-9]+\.tmp$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await fs.stat(file);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await fs.unlink(file);
      removed += 1;
    } catch {
      // A concurrent writer may have renamed/removed it already.
    }
  }
  return removed;
}

/** Read-only counts for live/archived handoff artifacts and stale hidden temps. */
export async function summarizeHandoffDirectory(dir, { now = Date.now() } = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { live: 0, archived: 0, stale_temps: 0, newest_age_minutes: -1, distinct_tasks: 0, unscoped: 0, task_ids: [] };
  }
  let live = 0;
  let staleTemps = 0;
  let newest = 0;
  let unscoped = 0;
  const tasks = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (/^\..+\.[0-9]+\.tmp$/.test(entry.name)) {
      staleTemps += 1;
      continue;
    }
    if (!entry.name.endsWith('.md')) continue;
    try {
      const file = path.join(dir, entry.name);
      const text = await fs.readFile(file, 'utf8');
      const firstLine = text.split('\n', 1)[0];
      if (!firstLine.startsWith(HANDOFF_TITLE)) continue;
      live += 1;
      const info = await fs.stat(file);
      if (info.mtimeMs > newest) newest = info.mtimeMs;
      const task = /^- task: (.+)$/m.exec(text);
      const value = task === null ? '(not specified)' : task[1].trim();
      if (['(not specified)', '(none)', ''].includes(value)) unscoped += 1;
      else tasks.add(value);
    } catch {
      // Ignore unreadable artifacts.
    }
  }
  let archived = 0;
  try {
    const archivedEntries = await fs.readdir(path.join(dir, 'archive'));
    archived = archivedEntries.filter((name) => name.endsWith('.md')).length;
  } catch {
    archived = 0;
  }
  return {
    live,
    archived,
    stale_temps: staleTemps,
    newest_age_minutes: newest === 0 ? -1 : Math.max(0, Math.round(((now - newest) / 60_000) * 10) / 10),
    distinct_tasks: tasks.size,
    unscoped,
    task_ids: [...tasks].sort().slice(0, 50),
  };
}

/**
 * Housekeeping used when a role policy is installed: remove stale hidden temps, then archive old
 * handoffs when retention is enabled. Returns counts for tests and diagnostics.
 */
export async function housekeepHandoffDirectory(dir, { now = Date.now(), retentionMs } = {}) {
  const cleaned = await cleanupStaleHandoffTemps(dir, { now });
  const archived =
    retentionMs === null || retentionMs === undefined
      ? 0
      : await archiveOldHandoffArtifacts(dir, { now, maxAgeMs: retentionMs });
  return { cleaned, archived };
}

/**
 * Move handoff artifacts older than `maxAgeMs` into `reviews/team/archive/`, preserving the newest
 * artifact for each teammate+task pair. This is archive-only: no handoff evidence is deleted.
 */
export async function archiveOldHandoffArtifacts(
  dir,
  { now = Date.now(), maxAgeMs = 90 * 24 * 60 * 60_000 } = {},
) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await fs.stat(file);
      const text = await fs.readFile(file, 'utf8');
      const firstLine = text.split('\n', 1)[0];
      if (!firstLine.startsWith(HANDOFF_TITLE)) continue;
      const task = /^- task: (.+)$/m.exec(text);
      const taskId = task === null ? '' : task[1].trim();
      artifacts.push({
        file,
        name: entry.name,
        at: info.mtimeMs,
        member: firstLine.slice(HANDOFF_TITLE.length),
        taskId,
        old: now - info.mtimeMs > maxAgeMs,
      });
    } catch {
      // Ignore unreadable/racing artifacts.
    }
  }
  const newestPerKey = new Map();
  for (const item of artifacts) {
    const key = `${item.member}\0${item.taskId}`;
    const previous = newestPerKey.get(key);
    if (previous === undefined || item.at > previous.at) newestPerKey.set(key, item);
  }
  let moved = 0;
  let archiveDir = null;
  for (const item of artifacts) {
    if (!item.old) continue;
    const newest = newestPerKey.get(`${item.member}\0${item.taskId}`);
    if (newest !== undefined && newest.file === item.file) continue;
    if (archiveDir === null) {
      archiveDir = path.join(dir, 'archive');
      await fs.mkdir(archiveDir, { recursive: true });
    }
    const destination = path.join(archiveDir, `${Date.now()}-${process.pid}-${item.name}`);
    try {
      await fs.rename(item.file, destination);
      moved += 1;
    } catch {
      // A concurrent prune may have moved it already.
    }
  }
  return moved;
}

/** Backwards-compatible newest single artifact for one teammate. */
export async function findLatestHandoffArtifact(dir, memberName, options = {}) {
  return (await findHandoffArtifacts(dir, memberName, options))[0] ?? null;
}

/**
 * Write one handoff artifact atomically and return its absolute path.
 * The temporary filename starts with a dot so it cannot be mistaken for an artifact even if cleanup fails.
 */
export async function writeHandoffArtifact(dir, memberName, content, { now = Date.now(), nonce = randomUUID() } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, handoffFileName(memberName, { now, nonce }));
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFileAtomic(file, content, { temporary });
  return file;
}
