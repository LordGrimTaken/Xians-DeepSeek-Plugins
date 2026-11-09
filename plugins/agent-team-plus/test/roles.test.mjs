import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRole, splitFrontmatter, summarizeRole } from '../src/roles.js';

const REVIEWER = `---
description: Read-only security reviewer.
tools_allow: read, glob, grep, web_fetch
tools_deny: write, edit, pwsh
write_scopes: reviews/security
max_tool_calls: 60
max_minutes: 20
context: fresh
---
You are a security reviewer. Report findings, never edit files.
`;

test('splitFrontmatter separates meta and body', () => {
  const { meta, body } = splitFrontmatter(REVIEWER);
  assert.equal(meta.get('description'), 'Read-only security reviewer.');
  assert.match(body, /security reviewer/);
});

test('parseRole normalizes lists, numbers, and context', () => {
  const role = parseRole(REVIEWER, 'reviewer');
  assert.equal(role.name, 'reviewer');
  assert.deepEqual(role.toolsAllow, ['read', 'glob', 'grep', 'web_fetch']);
  assert.deepEqual(role.toolsDeny, ['write', 'edit', 'pwsh']);
  assert.deepEqual(role.writeScopes, ['reviews/security']);
  assert.equal(role.maxToolCalls, 60);
  assert.equal(role.maxMinutes, 20);
  assert.equal(role.context, 'fresh');
});

test('parseRole leaves write scopes null when the field is absent', () => {
  const role = parseRole('---\ndescription: no writes key\n---\nbody', 'plain');
  assert.equal(role.writeScopes, null);
  assert.equal(role.maxToolCalls, null);
  assert.equal(role.context, 'fresh');
});

test('parseRole supports bracket lists and empty write scopes', () => {
  const role = parseRole('---\nwrite_scopes: []\n---\nbody', 'locked');
  assert.deepEqual(role.writeScopes, []);
});

test('deny_commands split on || so regexes may contain commas', () => {
  const role = parseRole('---\ndeny_commands: \\d{1,3}\\.\\d{1,3} || \\bdocker\\s+push\\b\n---\nbody', 'regexed');
  assert.deepEqual(role.denyCommands, ['\\d{1,3}\\.\\d{1,3}', '\\bdocker\\s+push\\b']);
});

test('unknown skills key is rejected as dead data', () => {
  assert.throws(() => parseRole('---\nskills: a,b\n---\nbody', 'ok'), /unknown frontmatter key/);
});

test('summarizeRole omits optional null fields', () => {
  const role = parseRole('---\ndescription: x\n---\nbody', 'plain');
  const summary = summarizeRole(role);
  assert.equal('write_scopes' in summary, false);
  assert.equal('max_tool_calls' in summary, false);
  assert.equal('model_intent' in summary, false);
  const full = summarizeRole(parseRole(REVIEWER, 'reviewer'));
  assert.deepEqual(full.write_scopes, ['reviews/security']);
  assert.equal(full.max_tool_calls, 60);
});

test('parseRole rejects missing body, bad names, unknown keys, and overlaps', () => {
  assert.throws(() => parseRole('---\ndescription: x\n---\n', 'ok'), /no instructions body/);
  assert.throws(() => parseRole('---\ndescription: x\n---\nbody', 'Bad_Name'), /invalid role name/);
  assert.throws(() => parseRole('---\nnope: 1\n---\nbody', 'ok'), /unknown frontmatter key/);
  assert.throws(
    () => parseRole('---\ntools_allow: read\ntools_deny: read\n---\nbody', 'ok'),
    /overlap/,
  );
});
