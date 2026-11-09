import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  decideCall,
  recordCall,
  relativePath,
  isUnderAnyScope,
  extractPaths,
  composeSpawnPrompt,
  providerForContext,
  renderHandoff,
} from '../src/policy.js';

const baseRole = {
  name: 'reviewer',
  description: 'Read-only reviewer.',
  toolsAllow: ['read', 'glob'],
  toolsDeny: ['write', 'edit'],
  writeScopes: ['reviews/security'],
  denyCommands: [],
  maxToolCalls: 3,
  maxMinutes: null,
  context: 'fresh',
};

const freshBudget = (role = baseRole) => {
  const budget = createBudget(role);
  budget.startedAt = Date.now();
  return budget;
};

test('team tools bypass budgets and role masks', () => {
  const role = { ...baseRole, maxToolCalls: 0 };
  const budget = freshBudget(role);
  const decision = decideCall({ role, budget, toolName: 'send_message', args: {}, cwd: 'C:/ws' });
  assert.equal(decision.allowed, true);
});

test('tool deny list blocks a named tool', () => {
  const budget = freshBudget({ ...baseRole, toolsAllow: [] });
  const decision = decideCall({ role: { ...baseRole, toolsAllow: [] }, budget, toolName: 'write', args: {}, cwd: 'C:/ws' });
  assert.equal(decision.allowed, false);
  assert.match(decision.deny, /does not allow the "write" tool/);
});

test('allow list is re-checked by the guard, including late-registered globals', () => {
  const budget = freshBudget(baseRole);
  const decision = decideCall({ role: { ...baseRole, toolsDeny: [] }, budget, toolName: 'pwsh', args: {}, cwd: 'C:/ws' });
  assert.equal(decision.allowed, false);
  assert.match(decision.deny, /only allows these tools: read, glob/);
});

test('tool budget blocks after the configured number of allowed calls', () => {
  const role = { ...baseRole, maxToolCalls: 2, toolsDeny: [] };
  const budget = freshBudget(role);
  assert.equal(decideCall({ role, budget, toolName: 'read', args: {}, cwd: 'C:/ws' }).allowed, true);
  recordCall(budget);
  assert.equal(decideCall({ role, budget, toolName: 'read', args: {}, cwd: 'C:/ws' }).allowed, true);
  recordCall(budget);
  const blocked = decideCall({ role, budget, toolName: 'read', args: {}, cwd: 'C:/ws' });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.deny, /budget exhausted/i);
});

test('time budget blocks when the window expired', () => {
  const role = { ...baseRole, maxToolCalls: null, maxMinutes: 10, toolsDeny: [] };
  const budget = freshBudget(role);
  budget.startedAt = Date.now() - 11 * 60_000;
  const blocked = decideCall({ role, budget, toolName: 'read', args: {}, cwd: 'C:/ws', now: Date.now() });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.deny, /Time budget exhausted/);
});

test('shell destructive commands are denied by default', () => {
  const role = { ...baseRole, toolsAllow: [], toolsDeny: [], maxToolCalls: null };
  const budget = freshBudget(role);
  for (const command of ['git push origin main', 'git reset --hard HEAD~1', 'rm -rf build']) {
    const decision = decideCall({ role, budget, toolName: 'pwsh', args: { command }, cwd: 'C:/ws' });
    assert.equal(decision.allowed, false, command);
  }
});

test('role-specific deny commands are appended', () => {
  const role = { ...baseRole, toolsAllow: [], toolsDeny: [], maxToolCalls: null, denyCommands: ['\\bdocker\\s+push\\b'] };
  const budget = freshBudget(role);
  const decision = decideCall({ role, budget, toolName: 'bash', args: { command: 'docker push me/app:latest' }, cwd: 'C:/ws' });
  assert.equal(decision.allowed, false);
});

test('write scopes accept in-scope relative and absolute paths, reject others', () => {
  const role = { ...baseRole, toolsAllow: [], toolsDeny: [], maxToolCalls: null };
  const budget = freshBudget(role);
  const okRel = decideCall({ role, budget, toolName: 'write', args: { file_path: 'reviews/security/findings.md' }, cwd: 'C:/ws' });
  assert.equal(okRel.allowed, true);
  const okAbs = decideCall({ role, budget, toolName: 'write', args: { file_path: 'C:/ws/reviews/security/report.md' }, cwd: 'C:/ws' });
  assert.equal(okAbs.allowed, true);
  const outside = decideCall({ role, budget, toolName: 'write', args: { file_path: 'src/index.js' }, cwd: 'C:/ws' });
  assert.equal(outside.allowed, false);
  assert.match(outside.deny, /may only write inside/);
  const absoluteOutside = decideCall({ role, budget, toolName: 'write', args: { file_path: 'C:/elsewhere/x.md' }, cwd: 'C:/ws' });
  assert.equal(absoluteOutside.allowed, false);
});

test('write scopes cannot be walked out of with .. segments', () => {
  const role = { ...baseRole, toolsAllow: [], toolsDeny: [], maxToolCalls: null };
  const budget = freshBudget(role);
  for (const candidate of [
    'reviews/security/../../outside.md',
    './reviews/security/../escape.md',
    'C:/ws/reviews/security/../../../outside.md',
  ]) {
    const decision = decideCall({ role, budget, toolName: 'write', args: { file_path: candidate }, cwd: 'C:/ws' });
    assert.equal(decision.allowed, false, candidate);
  }
  assert.equal(relativePath('../outside.md', 'C:/ws'), null);
  assert.equal(relativePath('reviews/security/../../outside.md', 'C:/ws'), 'outside.md');
  assert.equal(isUnderAnyScope('outside.md', ['reviews/security']), false);
  assert.equal(relativePath('reviews/security/./findings.md', 'C:/ws'), 'reviews/security/findings.md');
});

test('empty write scopes deny every write, and pathless writes are denied', () => {
  const role = { ...baseRole, toolsAllow: [], toolsDeny: [], maxToolCalls: null, writeScopes: [] };
  const budget = freshBudget(role);
  assert.equal(decideCall({ role, budget, toolName: 'write', args: { file_path: 'reviews/x.md' }, cwd: 'C:/ws' }).allowed, false);
  assert.equal(decideCall({ role, budget, toolName: 'apply_patch', args: {}, cwd: 'C:/ws' }).allowed, false);
});

test('provider selection follows the context mode', () => {
  assert.equal(providerForContext('fork'), 'fork');
  assert.equal(providerForContext('fresh'), 'spawn');
  assert.equal(providerForContext(undefined), 'spawn');
});

test('path helpers normalize Windows and workspace-relative paths', () => {
  assert.equal(relativePath('C:\\ws\\a\\b.md', 'C:\\ws'), 'a/b.md');
  assert.equal(relativePath('./a/b.md', 'C:/ws'), 'a/b.md');
  assert.equal(relativePath('C:/other/b.md', 'C:/ws'), null);
  assert.equal(isUnderAnyScope('a/b/c.md', ['a/b']), true);
  assert.equal(isUnderAnyScope('a/bc.md', ['a/b']), false);
  assert.deepEqual(extractPaths({ paths: ['x', 'y'] }), ['x', 'y']);
});

test('composeSpawnPrompt includes role policy and assignment', () => {
  const text = composeSpawnPrompt(baseRole, 'Review the auth diff.');
  assert.match(text, /Role: reviewer/);
  assert.match(text, /Writable paths: reviews\/security/);
  assert.match(text, /Your assignment/);
  assert.match(text, /Review the auth diff\./);
  assert.match(text, /team_handoff/);
});

test('renderHandoff writes sections and handles empty lists', () => {
  const md = renderHandoff({
    roleName: 'reviewer',
    summary: 'All good',
    deliverablePaths: ['reviews/security/x.md'],
    evidence: [],
    openQuestions: [],
    confidence: 0.9,
  });
  assert.match(md, /summary: All good/);
  assert.match(md, /reviews\/security\/x\.md/);
  assert.match(md, /\(none\)/);
});
