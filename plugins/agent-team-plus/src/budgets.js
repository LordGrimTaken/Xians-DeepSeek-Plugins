/**
 * Durable per-teammate tool/time budget state.
 *
 * A host restart recreates the Agent object, which previously gave every role teammate a fresh
 * full tool/time window. Persist the window in the workspace so a cold-resumed teammate keeps its
 * original deadline and consumed call count. Files are written atomically and never contain secrets.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.js';

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Workspace-local budget file. */
export function roleBudgetsPath(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  return path.join(cwd, '.dsh', 'team-role-budgets.json');
}

function validName(value) {
  return typeof value === 'string' && NAME_RE.test(value);
}

/** Read one persisted budget, returning null for missing/invalid state. */
export async function readRoleBudget(cwd, teammateName) {
  if (!validName(teammateName)) return null;
  const file = roleBudgetsPath(cwd);
  if (file === null) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed[teammateName];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.calls !== 'number' || !Number.isInteger(value.calls) || value.calls < 0) return null;
    if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) return null;
    if (!validName(value.roleName)) return null;
    return { calls: value.calls, startedAt: value.startedAt, roleName: value.roleName };
  } catch {
    return null;
  }
}

/** Read valid persisted budgets without mutating them. */
export async function readRoleBudgets(cwd) {
  const file = roleBudgetsPath(cwd);
  if (file === null) return {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([name, value]) =>
          NAME_RE.test(name) &&
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Number.isInteger(value.calls) &&
          value.calls >= 0 &&
          typeof value.startedAt === 'number' &&
          Number.isFinite(value.startedAt) &&
          typeof value.roleName === 'string' &&
          NAME_RE.test(value.roleName),
      ),
    );
  } catch {
    return {};
  }
}

/** Persist one budget atomically while preserving other teammates' entries. */
export async function writeRoleBudget(cwd, teammateName, budget) {
  if (!validName(teammateName)) throw new Error(`invalid teammate name "${teammateName}"`);
  if (budget === null || typeof budget !== 'object' || !validName(budget.roleName)) {
    throw new Error('invalid role budget');
  }
  if (typeof budget.calls !== 'number' || !Number.isInteger(budget.calls) || budget.calls < 0) {
    throw new Error('invalid budget calls');
  }
  if (typeof budget.startedAt !== 'number' || !Number.isFinite(budget.startedAt)) {
    throw new Error('invalid budget startedAt');
  }
  const file = roleBudgetsPath(cwd);
  if (file === null) throw new Error('workspace directory is required for budget persistence');
  let data = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // Missing or damaged file: rebuild from this write.
  }
  data[teammateName] = { calls: budget.calls, startedAt: budget.startedAt, roleName: budget.roleName };
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Serialize async writes so callers can flush pending state at a durability boundary. */
export function createSerialWriter(task, onError) {
  let chain = Promise.resolve();
  const report = typeof onError === 'function' ? onError : () => {};
  return {
    enqueue(value) {
      chain = chain.then(() => task(value)).catch((error) => report(error));
      return chain;
    },
    flush() {
      return chain;
    },
  };
}

/** Build read-only per-teammate budget diagnostics, using role limits when available. */
export function describeBudgets(budgets, roleByName, now = Date.now(), memberNames = []) {
  const roles = roleByName instanceof Map ? roleByName : new Map();
  const names = new Set(memberNames);
  return Object.entries(budgets)
    .map(([teammate, budget]) => {
      const role = roles.get(budget.roleName) ?? null;
      const maxCalls = typeof role?.maxToolCalls === 'number' ? role.maxToolCalls : null;
      const maxMinutes = typeof role?.maxMinutes === 'number' ? role.maxMinutes : null;
      const minutesUsed = Math.max(0, (now - budget.startedAt) / 60_000);
      return {
        teammate,
        role: budget.roleName,
        live: names.has(teammate),
        calls: budget.calls,
        remaining_calls: maxCalls === null ? -1 : Math.max(0, maxCalls - budget.calls),
        started_at: budget.startedAt,
        remaining_minutes: maxMinutes === null ? -1 : Math.max(0, maxMinutes - minutesUsed),
      };
    })
    .sort((a, b) => a.teammate.localeCompare(b.teammate));
}

/**
 * Return a budget window for an install. A persisted window is reused only when the role is the
 * same; otherwise the new role gets a fresh window. `createBudget` is injected by the caller.
 */
export function restoreRoleBudget(createBudget, role, persisted) {
  const budget = createBudget(role);
  if (
    persisted === null ||
    persisted === undefined ||
    persisted.roleName !== role.name ||
    !Number.isInteger(persisted.calls) ||
    persisted.calls < 0 ||
    !Number.isFinite(persisted.startedAt)
  ) {
    return budget;
  }
  return { ...budget, calls: persisted.calls, startedAt: persisted.startedAt };
}
