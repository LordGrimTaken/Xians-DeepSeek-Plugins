/**
 * Small durable atomic-file writer: private temp file -> fsync -> rename. Used for the persistent
 * role-binding and budget JSON files so a power loss cannot leave them half-written.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Best-effort directory fsync so a rename's directory entry is durable where the platform allows it. */
export async function syncDirectory(dir) {
  let handle = null;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Some platforms/filesystems refuse fsync on directories; the file data is still durable.
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }
}

/**
 * Remove abandoned temp files for the plugin's durable state files in a directory. Only exact
 * base-name prefixes, the module's numeric-pid + UUID temp shape, and age are matched.
 */
export async function cleanupStaleAtomicTemps(
  dir,
  {
    now = Date.now(),
    maxAgeMs = 60 * 60_000,
    baseNames = ['team-role-budgets.json', 'team-role-bindings.json'],
  } = {},
) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const matched = baseNames.some(
      (base) => entry.name.startsWith(`${base}.`) && /^\.[0-9]+\.[0-9a-f-]{36}\.tmp$/.test(entry.name.slice(base.length)),
    );
    if (!matched) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await fs.stat(file);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await fs.unlink(file);
      removed += 1;
    } catch {
      // Ignore a racing writer or an unreadable entry.
    }
  }
  return removed;
}

export async function writeFileAtomic(file, content, { mode = 0o600, temporary: requestedTemporary } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = requestedTemporary ?? `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temporary, 'w', mode);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
