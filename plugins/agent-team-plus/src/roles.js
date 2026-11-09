/**
 * Team role definitions for `@local/agent-team-plus`.
 *
 * A role is a Markdown file under `~/.dsh/team-roles/` or `<workspace>/.dsh/team-roles/` with a simple
 * frontmatter block:
 *
 *   ---
 *   description: Read-only security reviewer; reports findings, never edits.
 *   tools_allow: read, glob, grep, web_fetch, web_search
 *   tools_deny: write, edit, pwsh, bash
 *   write_scopes: reviews/security
 *   max_tool_calls: 60
 *   max_minutes: 20
 *   context: fresh
 *   ---
 *   You are a security reviewer...
 *
 * The body is the role's standing instructions. `tools_allow` / `tools_deny` name global tools only;
 * the Team coordination tools stay available to every member regardless of the role.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic } from './fs-atomic.js';

/** Valid role-name shape: lowercase kebab, up to 32 characters. */
export const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const LIST_KEYS = new Set(['tools_allow', 'tools_deny', 'write_scopes', 'deny_commands']);
const NUMBER_KEYS = new Set(['max_tool_calls', 'max_minutes']);
const BOOLEAN_KEYS = new Set(['model_strict']);
const KNOWN_KEYS = new Set([
  'description',
  'context',
  'model',
  ...BOOLEAN_KEYS,
  ...LIST_KEYS,
  ...NUMBER_KEYS,
]);

/** Split a role file into its frontmatter entries and the markdown body. */
export function splitFrontmatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  if (lines[start]?.trim() !== '---') throw new Error(`role file must start with a frontmatter block ("---") at line ${start + 1}`);
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '---') end += 1;
  if (end >= lines.length) throw new Error(`role frontmatter block opened at line ${start + 1} is not closed with "---"`);
  const meta = new Map();
  let lineNumber = start + 2;
  for (const line of lines.slice(start + 1, end)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { lineNumber += 1; continue; }
    const at = trimmed.indexOf(':');
    if (at <= 0) throw new Error(`invalid frontmatter line at line ${lineNumber}: ${trimmed}`);
    const key = trimmed.slice(0, at).trim().toLowerCase();
    const raw = trimmed.slice(at + 1).trim();
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown frontmatter key "${key}" at line ${lineNumber}`);
    meta.set(key, raw);
    lineNumber += 1;
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

function parseList(raw, separator = ',') {
  const value = String(raw ?? '').trim();
  if (value === '') return [];
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped
    .split(separator)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item !== '');
}

function parseBoolean(key, raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (['true', 'yes', '1'].includes(value)) return true;
  if (['false', 'no', '0'].includes(value)) return false;
  throw new Error(`${key} must be a boolean (true/false, yes/no, or 1/0)`);
}

function parsePositiveNumber(key, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
  return value;
}

/** Parse one role file into a normalized role record. */
export function parseRole(text, name, sourcePath = '') {
  if (!ROLE_NAME_RE.test(name)) throw new Error(`invalid role name "${name}" (lowercase kebab, 1-32 chars)`);
  const { meta, body } = splitFrontmatter(text);
  if (body === '') throw new Error(`role "${name}" has no instructions body`);
  const description = (meta.get('description') ?? '').trim() || `${name} teammate role`;
  if (description.length > 400) throw new Error('description must be at most 400 characters');
  const role = {
    name,
    description,
    body,
    sourcePath,
    toolsAllow: parseList(meta.get('tools_allow')),
    toolsDeny: parseList(meta.get('tools_deny')),
    writeScopes: meta.has('write_scopes') ? parseList(meta.get('write_scopes')) : null,
    denyCommands: parseList(meta.get('deny_commands'), '||'),
    maxToolCalls: meta.has('max_tool_calls') ? parsePositiveNumber('max_tool_calls', meta.get('max_tool_calls')) : null,
    maxMinutes: meta.has('max_minutes') ? parsePositiveNumber('max_minutes', meta.get('max_minutes')) : null,
    context: (meta.get('context') ?? 'fresh').trim(),
    model: (meta.get('model') ?? '').trim() || null,
    modelStrict: meta.has('model_strict') ? parseBoolean('model_strict', meta.get('model_strict')) : false,
  };
  if (role.context !== 'fresh' && role.context !== 'fork') throw new Error('context must be "fresh" or "fork"');
  if (role.modelStrict && role.model === null) throw new Error('model_strict requires a model intent');
  if (role.toolsAllow.length > 0 && role.toolsDeny.length > 0) {
    const overlap = role.toolsAllow.filter((tool) => role.toolsDeny.includes(tool));
    if (overlap.length > 0) throw new Error(`tools_allow and tools_deny overlap: ${overlap.join(', ')}`);
  }
  return role;
}

/** Candidate role directories for one workspace, broad to specific (later overrides earlier). */
export function roleDirectories(cwd) {
  const dirs = [path.join(os.homedir(), '.dsh', 'team-roles')];
  if (typeof cwd === 'string' && cwd !== '') dirs.push(path.join(cwd, '.dsh', 'team-roles'));
  return dirs;
}

/** Workspace-local file that remembers which role a teammate name was spawned from. */
export function roleBindingsPath(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  return path.join(cwd, '.dsh', 'team-role-bindings.json');
}

/**
 * Read the persisted role name for a teammate. Invalid/missing files are ignored so a damaged
 * binding can never widen a teammate's policy; the caller falls back to the role named like the
 * teammate, preserving the old v0.1 behavior.
 */
export async function readRoleBinding(cwd, teammateName) {
  if (typeof teammateName !== 'string' || !ROLE_NAME_RE.test(teammateName)) return null;
  const file = roleBindingsPath(cwd);
  if (file === null) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const roleName = parsed[teammateName];
    return typeof roleName === 'string' && ROLE_NAME_RE.test(roleName) ? roleName : null;
  } catch {
    return null;
  }
}

/** Persist one teammate→role binding atomically, preserving other bindings in the workspace. */
export async function writeRoleBinding(cwd, teammateName, roleName) {
  if (typeof teammateName !== 'string' || !ROLE_NAME_RE.test(teammateName)) {
    throw new Error(`invalid teammate name "${teammateName}"`);
  }
  if (typeof roleName !== 'string' || !ROLE_NAME_RE.test(roleName)) {
    throw new Error(`invalid role name "${roleName}"`);
  }
  const file = roleBindingsPath(cwd);
  if (file === null) throw new Error('workspace directory is required for role bindings');
  let bindings = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) bindings = parsed;
  } catch {
    // Missing or damaged bindings: rebuild from this write.
  }
  bindings[teammateName] = roleName;
  await writeFileAtomic(file, `${JSON.stringify(bindings, null, 2)}\n`);
}

/** Read valid persisted teammate→role bindings without mutating them. */
export async function readRoleBindings(cwd) {
  const file = roleBindingsPath(cwd);
  if (file === null) return {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([name, role]) => ROLE_NAME_RE.test(name) && typeof role === 'string' && ROLE_NAME_RE.test(role),
      ),
    );
  } catch {
    return {};
  }
}

/** Remove one persisted teammate→role binding; returns whether an entry was removed. */
export async function deleteRoleBinding(cwd, teammateName) {
  if (typeof teammateName !== 'string' || !ROLE_NAME_RE.test(teammateName)) {
    throw new Error(`invalid teammate name "${teammateName}"`);
  }
  const file = roleBindingsPath(cwd);
  if (file === null) throw new Error('workspace directory is required for role bindings');
  let bindings = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) bindings = parsed;
  } catch {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(bindings, teammateName)) return false;
  delete bindings[teammateName];
  await writeFileAtomic(file, `${JSON.stringify(bindings, null, 2)}\n`);
  return true;
}

/** Drop the discovery cache for one workspace, or all workspaces when omitted. */
export function clearRoleCache(cwd) {
  if (cwd === undefined) roleCache.clear();
  else roleCache.delete(typeof cwd === 'string' ? cwd : '');
}

/** Read-only binding rows with liveness for diagnostics. */
export function describeBindings(bindings, memberNames = []) {
  const names = new Set(memberNames);
  return Object.entries(bindings)
    .map(([teammate, role]) => ({ teammate, role, live: names.has(teammate) }))
    .sort((a, b) => a.teammate.localeCompare(b.teammate));
}

/** Cache keyed by workspace: role discovery signature -> normalized role map. */
const roleCache = new Map();
const ROLE_CACHE_LIMIT = 32;

async function roleSignature(cwd) {
  const parts = [];
  for (const dir of roleDirectories(cwd)) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      parts.push(`missing\0${dir}`);
      continue;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const name = entry.name.slice(0, -3).toLowerCase();
      if (!ROLE_NAME_RE.test(name)) continue;
      const sourcePath = path.join(dir, entry.name);
      try {
        const info = await fs.stat(sourcePath);
        files.push(`${name}\0${info.mtimeMs}\0${info.size}`);
      } catch {
        files.push(`${name}\0unreadable`);
      }
    }
    files.sort();
    parts.push(`dir\0${dir}\0${files.join('\0')}`);
  }
  return parts.join('\0');
}

/**
 * Load every readable role for one workspace; a workspace role shadows the home role with the same
 * name. Discovery is cached by directory entries plus mtime/size, so changing/adding/deleting a
 * role file invalidates the cache without hashing every file on every tool call.
 */
export async function loadRoles(cwd) {
  const signature = await roleSignature(cwd);
  const cacheKey = typeof cwd === 'string' ? cwd : '';
  const cached = roleCache.get(cacheKey);
  if (cached !== undefined && cached.signature === signature) return cached.roles;

  const roles = new Map();
  for (const dir of roleDirectories(cwd)) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const name = entry.name.slice(0, -3).toLowerCase();
      if (!ROLE_NAME_RE.test(name)) continue;
      const sourcePath = path.join(dir, entry.name);
      try {
        const text = await fs.readFile(sourcePath, 'utf8');
        roles.set(name, parseRole(text, name, sourcePath));
      } catch (error) {
        roles.set(name, { name, error: `invalid role file ${sourcePath}: ${error.message}`, sourcePath });
      }
    }
  }
  roleCache.set(cacheKey, { signature, roles });
  if (roleCache.size > ROLE_CACHE_LIMIT) {
    const oldest = roleCache.keys().next().value;
    if (oldest !== cacheKey) roleCache.delete(oldest);
  }
  return roles;
}

/** Resolve one role or throw an actionable error listing what is available. */
export async function resolveRole(cwd, name) {
  const requested = String(name ?? '').trim().toLowerCase();
  if (!ROLE_NAME_RE.test(requested)) throw new Error(`invalid role name "${name}"`);
  const roles = await loadRoles(cwd);
  const role = roles.get(requested);
  if (role === undefined) {
    const available = [...roles.keys()].sort();
    throw new Error(
      available.length === 0
        ? `unknown role "${requested}"; no roles found. Create one under ~/.dsh/team-roles/<name>.md`
        : `unknown role "${requested}"; available roles: ${available.join(', ')}`,
    );
  }
  if (role.error !== undefined) throw new Error(role.error);
  return role;
}

/** Compact model-facing summary of a role. Optional fields are omitted so the spawn tool result validates. */
export function summarizeRole(role) {
  const summary = {
    name: role.name,
    description: role.description,
    context: role.context,
    tools_allow: role.toolsAllow,
    tools_deny: role.toolsDeny,
  };
  if (role.writeScopes !== null) summary.write_scopes = role.writeScopes;
  if (role.maxToolCalls !== null) summary.max_tool_calls = role.maxToolCalls;
  if (role.maxMinutes !== null) summary.max_minutes = role.maxMinutes;
  if (role.model !== null) summary.model_intent = role.model;
  if (role.modelStrict) summary.model_strict = true;
  return summary;
}
