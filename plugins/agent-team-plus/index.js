/**
 * @local/agent-team-plus — host half.
 *
 * Extends the shipped Agent Teams bundle with:
 *  - `spawn_role` / `team_roles`: reusable role definitions from `~/.dsh/team-roles/*.md` and
 *    `<workspace>/.dsh/team-roles/*.md`, composed into teammate prompts and enforced per teammate;
 *  - per-teammate tool masks (`tools.restrict`), pre-execute guards (`tools.guard`) for write scopes,
 *    destructive shell commands, and tool/time budgets;
 *  - `team_handoff`: writes a structured handoff artifact under `reviews/team/` and optionally sends
 *    the receiving member a lightweight reference;
 *  - a message-trust policy section for every team member.
 *
 * Linked workspace packages cannot resolve the harness's own packages, so tool definitions are authored in
 * the registry's enforced raw JSON-Schema subset (see `@local/dsh-plugin-run-hidden` for the same constraint).
 *
 * Requires services: agents, agentTeams, tools, systemPrompt, workingDirectory (Agent Teams bundle active).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  clearRoleCache,
  deleteRoleBinding,
  describeBindings,
  readRoleBindings,
  resolveRole,
  loadRoles,
  summarizeRole,
  readRoleBinding,
  writeRoleBinding,
} from './src/roles.js';
import {
  createSerialWriter,
  describeBudgets,
  readRoleBudget,
  readRoleBudgets,
  restoreRoleBudget,
  writeRoleBudget,
} from './src/budgets.js';
import { cleanupStaleAtomicTemps } from './src/fs-atomic.js';
import {
  archiveOldHandoffArtifacts,
  cleanupStaleHandoffTemps,
  findHandoffArtifacts,
  handoffRetentionMs,
  housekeepHandoffDirectory,
  summarizeHandoffDirectory,
  writeHandoffArtifact,
} from './src/handoff.js';
import {
  createBudget,
  decideCall,
  recordCall,
  composeSpawnPrompt,
  completionGate,
  evaluateModelIntent,
  handoffTargetError,
  handoffTaskError,
  parseModelIntent,
  withModelValidation,
  strictModelFailure,
  boundedHandoffList,
  boundedHandoffText,
  HANDOFF_LIMITS,
  leadPolicyText,
  messageTrustText,
  normalizeHandoffPaths,
  providerForContext,
  rolePolicyText,
  renderHandoff,
  diagnosticsSummary,
  diagnosticsWarnings,
  roleSpawnReadiness,
  TEAM_TOOLS,
} from './src/policy.js';

export const name = 'agent-team-plus';
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'workingDirectory'];

const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const MEMBER_VIEW_PROPERTIES = {
  target: { type: 'string', description: 'Member target used by send_message and task owner fields.' },
  role: { type: 'string', enum: ['lead', 'teammate'] },
  status: { type: 'string', enum: ['running', 'inactive', 'provisioning', 'failed'] },
  description: { type: 'string' },
  provider: { type: 'string' },
  context: { type: 'string', enum: ['fresh', 'fork'] },
  model: { type: 'string' },
  diagnostics: { type: 'array', items: { type: 'string' } },
};

const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'role', 'status', 'diagnostics'],
  properties: MEMBER_VIEW_PROPERTIES,
};

const ROLE_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'context', 'tools_allow', 'tools_deny'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    context: { type: 'string' },
    tools_allow: { type: 'array', items: { type: 'string' } },
    tools_deny: { type: 'array', items: { type: 'string' } },
    write_scopes: { type: 'array', items: { type: 'string' } },
    max_tool_calls: { type: 'number' },
    max_minutes: { type: 'number' },
    model_intent: { type: 'string' },
    model_strict: { type: 'boolean' },
  },
};

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['member', 'role'],
  properties: {
    member: MEMBER_VIEW_SCHEMA,
    role: ROLE_SUMMARY_SCHEMA,
    model_intent: { type: 'string' },
    model_status: { type: 'string', enum: ['valid', 'unknown', 'unavailable'] },
    model_warning: { type: 'string' },
  },
};

const DIAGNOSTICS_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspace', 'summary', 'roles', 'members', 'bindings', 'bound_teammates', 'budgeted_teammates', 'budget_details', 'handoffs', 'warnings'],
  properties: {
    workspace: { type: 'string' },
    summary: { type: 'string' },
    roles: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'valid', 'invalid', 'spawnable'],
      properties: {
        total: { type: 'integer' },
        valid: { type: 'integer' },
        invalid: { type: 'integer' },
        spawnable: { type: 'integer' },
      },
    },
    members: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'teammates'],
      properties: {
        total: { type: 'integer' },
        teammates: { type: 'integer' },
      },
    },
    bindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['teammate', 'role', 'live'],
        properties: {
          teammate: { type: 'string' },
          role: { type: 'string' },
          live: { type: 'boolean' },
        },
      },
    },
    bound_teammates: { type: 'array', items: { type: 'string' } },
    budgeted_teammates: { type: 'array', items: { type: 'string' } },
    budget_details: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['teammate', 'role', 'live', 'calls', 'remaining_calls', 'started_at', 'remaining_minutes'],
        properties: {
          teammate: { type: 'string' },
          role: { type: 'string' },
          live: { type: 'boolean' },
          calls: { type: 'integer' },
          remaining_calls: { type: 'integer' },
          started_at: { type: 'number' },
          remaining_minutes: { type: 'number' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    handoffs: {
      type: 'object',
      additionalProperties: false,
      required: ['live', 'archived', 'stale_temps', 'newest_age_minutes', 'distinct_tasks', 'unscoped', 'task_ids'],
      properties: {
        live: { type: 'integer' },
        archived: { type: 'integer' },
        stale_temps: { type: 'integer' },
        newest_age_minutes: { type: 'number' },
        distinct_tasks: { type: 'integer' },
        unscoped: { type: 'integer' },
        task_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const ROLES_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['roles'],
  properties: {
    roles: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const HANDOFF_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['artifact_path', 'bytes', 'summary'],
  properties: {
    artifact_path: { type: 'string' },
    bytes: { type: 'integer' },
    target: { type: 'string' },
    delivered: { type: 'boolean' },
    summary: { type: 'string' },
    task_id: { type: 'string' },
    archived_handoffs: { type: 'integer' },
    cleaned_handoff_temps: { type: 'integer' },
  },
};

/** Render a JSON value as the single text block the model reads. */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
}

/** Expose the member name as the model-facing target, dropping the session id. */
function modelMember(member) {
  const { id: _id, name, ...details } = member;
  return { target: name, ...details };
}

/** Resolve the calling agent, which Agent-scoped tool discovery guarantees. */
function callingAgent(agent, toolName) {
  if (agent === void 0) throw new Error(`${toolName} requires a calling Agent`);
  return agent;
}

/** Workspace directory for the caller, falling back to the deployment default. */
async function callerCwd(ctx, agent, signal) {
  try {
    return await ctx.workingDirectory.ensure(agent, signal);
  } catch {
    return ctx.workingDirectory.defaultDirectory;
  }
}

/** Roles keyed by name from the workspace, tolerating a missing/broken directory. */
async function safeLoadRoles(cwd) {
  try {
    return await loadRoles(cwd);
  } catch {
    return new Map();
  }
}

/** Find a role when the in-process spawn map was lost (e.g. after a host reload). */
async function fallbackRole(cwd, teammateName) {
  // Custom teammate names retain their role across a restart via a workspace-local binding.
  const persistedRole = await readRoleBinding(cwd, teammateName);
  if (persistedRole !== null) {
    try {
      return await resolveRole(cwd, persistedRole);
    } catch {
      // A deleted/invalid bound role must not widen policy; fall through to name-based recovery.
    }
  }
  try {
    return await resolveRole(cwd, teammateName);
  } catch {
    return null;
  }
}

/** Append one ordered system-prompt section, warning instead of failing the whole install. */
function addSection(ctx, scoped, disposers, { name: sectionName, order, text }) {
  try {
    disposers.push(
      scoped.systemPrompt.section({
        name: sectionName,
        order: Number.isFinite(order) ? order : 900,
        text,
      }),
    );
  } catch (error) {
    ctx.logger?.warn?.(`[agent-team-plus] system prompt section ${sectionName} failed: ${error.message}`);
  }
}

/** Validate a role's advisory model intent; never fail or block a spawn on catalog errors. */
const modelCatalogCache = new Map();

async function inspectModelIntent(ctx, role) {
  if (typeof role.model !== 'string' || role.model.trim() === '') return null;
  let llm = null;
  let defaultProvider = null;
  try {
    llm = ctx.get?.('llm') ?? null;
    defaultProvider = ctx.get?.('agentDefaultModel')?.currentSelection?.()?.provider ?? null;
  } catch {
    llm = null;
  }
  if (llm === null || typeof llm.listModels !== 'function') {
    return { status: 'unavailable', warning: `model intent "${role.model}" could not be validated: model service unavailable; the teammate inherits the default model.` };
  }
  let parsed = parseModelIntent(role.model, defaultProvider);
  if (parsed === null && (typeof defaultProvider !== 'string' || defaultProvider === '')) {
    try {
      defaultProvider = llm.listProviders?.()?.[0]?.id ?? null;
    } catch {
      defaultProvider = null;
    }
    parsed = parseModelIntent(role.model, defaultProvider);
  }
  if (parsed === null) {
    if (role.model.includes('/')) {
      return { status: 'unavailable', warning: `model intent "${role.model}" is malformed; use "model" or "provider/model". The teammate inherits the default model.` };
    }
    return { status: 'unavailable', warning: `model intent "${role.model}" could not be validated: no provider is available; the teammate inherits the default model.` };
  }
  const provider = parsed.provider;
  try {
    const cached = modelCatalogCache.get(provider);
    let models;
    if (cached !== undefined && Date.now() - cached.at < 30_000) {
      models = cached.models;
    } else {
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), 3000);
        timer.unref?.();
      });
      models = await Promise.race([
        Promise.resolve(llm.listModels(provider)).catch(() => []),
        timeout,
      ]);
      modelCatalogCache.set(provider, { at: Date.now(), models });
    }
    return evaluateModelIntent(parsed.model, models, provider);
  } catch (error) {
    return { status: 'unavailable', warning: `model intent "${role.model}" could not be validated: ${error.message}; the teammate inherits the default model.` };
  }
}

export function apply(ctx) {
  /** agent -> disposer for everything installed into that agent's scope. */
  const installed = new Map();
  /** teammate name -> role, primed by spawn_role before the child agent exists. */
  const pendingRoles = new Map();
  /** agent -> mutable budget window (only for role teammates). */
  const budgets = new Map();
  /** agent -> {at, artifactPath} of its last successful handoff (role teammates only). */
  const handoffs = new Map();
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[agent-team-plus] ${message}`);
    } catch {
      console.warn(`[agent-team-plus] ${message}`);
    }
  };

  /** Serialized best-effort writes of budget windows. */
  const budgetWriter = createSerialWriter(
    ({ cwd, teammateName, snapshot }) => writeRoleBudget(cwd, teammateName, snapshot),
    (error) => warn(`budget persistence failed: ${error.message}`),
  );

  const persistBudget = (cwd, teammateName, budget) => {
    const snapshot = { calls: budget.calls, startedAt: budget.startedAt, roleName: budget.roleName };
    budgetWriter.enqueue({ cwd, teammateName, snapshot });
  };
  const flushBudgets = () => budgetWriter.flush();

  /** Order a section next to the shipped Team policy section. */
  const baseOrder = (scoped) => {
    try {
      const order = scoped.systemPrompt.getSectionOrder('TEAM_POLICY');
      return Number.isFinite(order) ? order : 900;
    } catch {
      return 900;
    }
  };

  const registerHandoffTool = (scoped, disposers, onHandoff, beforeHandoff) => {
    disposers.push(
      scoped.tools.register({
        name: 'team_handoff',
        description:
          'Publish a structured handoff for your current work: writes a Markdown artifact under reviews/team/ and optionally sends the target a lightweight reference. Use this instead of pasting long reports into peer messages.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', description: 'One-paragraph result summary.' },
            deliverable_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workspace-relative paths of the produced or changed files.',
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'Commands run, tests passed, or checks that support the summary.',
            },
            open_questions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Anything unresolved or needing the Lead/user decision.',
            },
            confidence: { type: 'number', description: 'Confidence from 0 to 1.' },
            task_id: {
              type: 'string',
              description: 'Optional shared task this handoff supports; required to complete that task later.',
            },
            target: {
              type: 'string',
              description: 'Optional member target (for example "lead") to message with the artifact reference.',
            },
          },
          required: ['summary'],
        },
        output: jsonOutput(HANDOFF_VALUE_SCHEMA),
        async execute(args, exec) {
          const caller = callingAgent(exec.agent, 'team_handoff');
          const membership = ctx.agentTeams.membership(caller);
          if (typeof beforeHandoff === 'function') {
            try {
              await beforeHandoff();
            } catch (error) {
              warn(`pre-handoff budget flush failed: ${error.message}`);
            }
          }
          const cwd = await callerCwd(ctx, caller, exec.signal);
          const taskId =
            typeof args.task_id === 'string' && args.task_id.trim() !== ''
              ? boundedHandoffText(args.task_id, 200, 'task_id')
              : undefined;
          if (taskId !== undefined) {
            let task;
            try {
              task = ctx.agentTeams.getTask(caller, taskId);
            } catch (error) {
              throw new Error(`task_id "${taskId}" is not a live shared task: ${error.message}`);
            }
            const taskError = handoffTaskError(task, membership.name, membership.role === 'lead');
            if (taskError !== null) throw new Error(taskError);
          }
          const summary = boundedHandoffText(args.summary, HANDOFF_LIMITS.summaryChars, 'summary');
          const deliverablePaths = boundedHandoffList(
            normalizeHandoffPaths(args.deliverable_paths, cwd),
            HANDOFF_LIMITS.deliverablePathItems,
            HANDOFF_LIMITS.deliverablePathChars,
            'deliverable_paths',
          );
          const evidence = boundedHandoffList(
            args.evidence,
            HANDOFF_LIMITS.evidenceItems,
            HANDOFF_LIMITS.evidenceChars,
            'evidence',
          );
          const openQuestions = boundedHandoffList(
            args.open_questions,
            HANDOFF_LIMITS.openQuestionItems,
            HANDOFF_LIMITS.openQuestionChars,
            'open_questions',
          );
          const confidence =
            typeof args.confidence === 'number' && Number.isFinite(args.confidence)
              ? Math.max(0, Math.min(1, args.confidence))
              : null;
          const target =
            typeof args.target === 'string' && args.target.trim() !== ''
              ? boundedHandoffText(args.target, HANDOFF_LIMITS.targetChars, 'target')
              : undefined;
          if (target !== undefined) {
            let members = [];
            try {
              members = ctx.agentTeams.listMembers(caller);
            } catch {
              members = [];
            }
            const targetMember = members.find((member) => member.name === target);
            const targetError = handoffTargetError(targetMember, membership.name);
            if (targetError !== null) {
              const available = members.length > 0 ? members.map((member) => member.name).join(', ') : 'no live members';
              throw new Error(`unknown handoff target "${target}": ${targetError}; live members: ${available}`);
            }
          }
          const content = renderHandoff({
            roleName: membership.name,
            summary,
            deliverablePaths,
            evidence,
            openQuestions,
            confidence,
            taskId,
          });
          const dir = path.join(cwd, 'reviews', 'team');
          const file = await writeHandoffArtifact(dir, membership.name, content);
          const cleanedTemps = await cleanupStaleHandoffTemps(dir).catch((error) => {
            warn(`handoff temp cleanup failed: ${error.message}`);
            return 0;
          });
          const retentionMs = handoffRetentionMs(process.env);
          let archivedCount = 0;
          if (retentionMs !== null) {
            archivedCount = await archiveOldHandoffArtifacts(dir, { maxAgeMs: retentionMs }).catch((error) => {
              warn(`handoff archive cleanup failed: ${error.message}`);
              return 0;
            });
          }
          const artifactPath = path.relative(cwd, file).replace(/\\/g, '/');
          if (typeof onHandoff === 'function') {
            try {
              onHandoff({ artifactPath, at: Date.now(), taskId });
            } catch (error) {
              warn(`handoff bookkeeping failed: ${error.message}`);
            }
          }
          const result = {
            artifact_path: artifactPath,
            bytes: Buffer.byteLength(content, 'utf8'),
            summary,
            ...(archivedCount > 0 ? { archived_handoffs: archivedCount } : {}),
            ...(cleanedTemps > 0 ? { cleaned_handoff_temps: cleanedTemps } : {}),
            ...(taskId === undefined ? {} : { task_id: taskId }),
          };
          if (target !== undefined) {
            const lines = [
              `Handoff from ${membership.name}: ${summary}`,
              `Artifact: ${artifactPath}`,
              deliverablePaths.length > 0 ? `Deliverables: ${deliverablePaths.join(', ')}` : null,
              openQuestions.length > 0 ? `Open questions: ${openQuestions.join('; ')}` : null,
              'The full report is in the artifact; read it rather than relying on this summary.',
            ].filter((line) => line !== null);
            try {
              await ctx.agentTeams.sendMessage(caller, {
                target,
                content: [{ type: 'text', text: lines.join('\n') }],
                signal: exec.signal,
              });
              result.target = target;
              result.delivered = true;
            } catch (error) {
              result.target = target;
              result.delivered = false;
              warn(`handoff message to ${target} failed: ${error.message}`);
            }
          }
          return result;
        },
      }),
    );
  };

  const registerLeadTools = (scoped, disposers) => {
    disposers.push(
      scoped.tools.register({
        name: 'team_roles',
        description:
          'List reusable teammate roles from ~/.dsh/team-roles/*.md and <workspace>/.dsh/team-roles/*.md, with their tool masks, write scopes, and budgets. Team Lead only.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            refresh: { type: 'boolean', description: 'Bypass the discovery cache and re-read role files.' },
          },
        },
        output: jsonOutput(ROLES_VALUE_SCHEMA),
        async execute(args, exec) {
          const caller = callingAgent(exec.agent, 'team_roles');
          const cwd = await callerCwd(ctx, caller, exec.signal);
          if (args.refresh === true) clearRoleCache(cwd);
          const roles = await safeLoadRoles(cwd);
          let existingNames = [];
          try {
            existingNames = ctx.agentTeams.listMembers(caller).map((member) => member.name);
          } catch {
            existingNames = [];
          }
          const sorted = [...roles.values()].sort((a, b) => a.name.localeCompare(b.name));
          const rows = await Promise.all(
            sorted.map(async (role) => {
              if (role.error !== undefined) {
                return {
                  name: role.name,
                  error: role.error,
                  source_path: role.sourcePath,
                  ...roleSpawnReadiness(role, { existingNames }),
                };
              }
              const summary = summarizeRole(role);
              const validation = await inspectModelIntent(ctx, role);
              return {
                ...withModelValidation(summary, validation, role.modelStrict),
                source_path: role.sourcePath,
                ...roleSpawnReadiness(role, {
                  existingNames,
                  modelStatus: validation?.status ?? null,
                }),
              };
            }),
          );
          return { roles: rows };
        },
      }),
    );
    disposers.push(
      scoped.tools.register({
        name: 'team_diagnostics',
        description:
          'Read-only Agent Teams Plus health snapshot: role counts, live members, persisted bindings/budgets, and handoff artifact counts. Team Lead only.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: jsonOutput(DIAGNOSTICS_VALUE_SCHEMA),
        async execute(_args, exec) {
          const caller = callingAgent(exec.agent, 'team_diagnostics');
          const cwd = await callerCwd(ctx, caller, exec.signal);
          const roles = await safeLoadRoles(cwd);
          const bindings = await readRoleBindings(cwd);
          const budgets = await readRoleBudgets(cwd);
          const handoffs = await summarizeHandoffDirectory(path.join(cwd, 'reviews', 'team'));
          let members = [];
          try {
            members = ctx.agentTeams.listMembers(caller);
          } catch {
            members = [];
          }
          let taskStatuses = null;
          try {
            taskStatuses = new Map(ctx.agentTeams.listTasks(caller).map((task) => [task.id, task.status]));
          } catch {
            taskStatuses = null;
          }
          const roleValues = [...roles.values()];
          const validRoles = new Map(
            roleValues.filter((role) => role.error === undefined).map((role) => [role.name, role]),
          );
          const existingNames = members.map((member) => member.name);
          const readiness = await Promise.all(
            roleValues.map(async (role) => {
              if (role.error !== undefined) return roleSpawnReadiness(role, { existingNames });
              const validation = await inspectModelIntent(ctx, role);
              return roleSpawnReadiness(role, {
                existingNames,
                modelStatus: validation?.status ?? null,
              });
            }),
          );
          const roleSummary = {
            total: roleValues.length,
            valid: roleValues.filter((role) => role.error === undefined).length,
            invalid: roleValues.filter((role) => role.error !== undefined).length,
            spawnable: readiness.filter((entry) => entry.spawnable).length,
          };
          const boundNames = Object.keys(bindings).sort();
          const budgetDetails = describeBudgets(budgets, validRoles);
          const warnings = diagnosticsWarnings({
            roles: roleSummary,
            handoffs,
            budgetDetails,
            boundTeammates: boundNames,
            memberNames: existingNames,
          });
          return {
            workspace: cwd,
            summary: diagnosticsSummary({ roles: roleSummary, handoffs, warnings }),
            roles: roleSummary,
            members: {
              total: members.length,
              teammates: members.filter((member) => member.role === 'teammate').length,
            },
            bindings: describeBindings(bindings, existingNames),
            bound_teammates: boundNames,
            budgeted_teammates: Object.keys(budgets).sort(),
            budget_details: budgetDetails,
            handoffs,
            warnings,
          };
        },
      }),
    );
    disposers.push(
      scoped.tools.register({
        name: 'spawn_role',
        description:
          'Create one durable teammate from a reusable role definition. The role enforces its tool mask, writable path scopes, and tool/time budget on the teammate. Team Lead only.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: {
              type: 'string',
              description: 'Role name from team_roles (lowercase kebab).',
            },
            task: {
              type: 'string',
              description:
                'Self-contained assignment for this teammate, including acceptance criteria and the deliverable you expect.',
            },
            name: {
              type: 'string',
              description:
                'Optional teammate name; defaults to the role name. Must be lowercase kebab and unique for the team.',
            },
            context: {
              type: 'string',
              enum: ['fresh', 'fork'],
              description: 'Optional context mode overriding the role default. fresh starts clean; fork inherits your completed turns.',
            },
          },
          required: ['role', 'task'],
        },
        output: jsonOutput(SPAWN_VALUE_SCHEMA),
        async execute(args, exec) {
          const caller = callingAgent(exec.agent, 'spawn_role');
          const membership = ctx.agentTeams.membership(caller);
          if (membership.role !== 'lead') throw new Error('spawn_role is only available to the Team Lead');
          const teammateName = String(args.name ?? args.role)
            .trim()
            .toLowerCase();
          if (!ROLE_NAME_RE.test(teammateName)) {
            throw new Error(`invalid teammate name "${teammateName}" (lowercase kebab, 1-32 chars)`);
          }
          const existing = ctx.agentTeams.listMembers(caller);
          if (existing.some((member) => member.name === teammateName && member.role === 'teammate')) {
            throw new Error(
              `a teammate named "${teammateName}" already exists; names are permanent, pick another name`,
            );
          }
          const cwd = await callerCwd(ctx, caller, exec.signal);
          const role = await resolveRole(cwd, args.role);
          const modelCheck = await inspectModelIntent(ctx, role);
          const strictFailure = strictModelFailure(role.modelStrict, modelCheck);
          if (strictFailure !== null) throw new Error(strictFailure);
          const context = args.context ?? role.context;
          if (context !== 'fresh' && context !== 'fork') throw new Error('context must be "fresh" or "fork"');
          const prompt = composeSpawnPrompt(role, String(args.task ?? '').trim());
          // Persist custom teammate-name→role bindings so cold-resumed agents get the same policy.
          await writeRoleBinding(cwd, teammateName, role.name).catch((error) => {
            warn(`could not persist role binding for "${teammateName}": ${error.message}`);
          });
          pendingRoles.set(teammateName, role);
          let spawned;
          try {
            spawned = await ctx.agentTeams.spawnTeammate(caller, {
              name: teammateName,
              description: role.description,
              prompt: [{ type: 'text', text: prompt }],
              context,
              provider: providerForContext(context),
              signal: exec.signal,
            });
          } catch (error) {
            pendingRoles.delete(teammateName);
            await deleteRoleBinding(cwd, teammateName).catch((cleanupError) => {
              warn(`could not remove role binding for "${teammateName}": ${cleanupError.message}`);
            });
            throw error;
          }
          const result = { member: modelMember(spawned.member), role: summarizeRole(role) };
          if (modelCheck !== null) {
            result.model_intent = role.model;
            result.model_status = modelCheck.status;
            result.model_warning = modelCheck.warning;
          }
          return result;
        },
      }),
    );
  };

  /** Install role policy, budget guard, and handoff tool into one team member scope. */
  const install = async (agent) => {
    const membership = ctx.agentTeams.tryMembership(agent);
    if (membership === undefined) return () => {};
    const scoped = agent.ctx;
    const disposers = [];
    const sectionBase = baseOrder(scoped);
    addSection(ctx, scoped, disposers, {
      name: 'team-plus:message-trust',
      order: sectionBase + 1,
      text: messageTrustText(),
    });
    if (membership.role === 'lead') {
      addSection(ctx, scoped, disposers, {
        name: 'team-plus:lead-policy',
        order: sectionBase + 2,
        text: leadPolicyText(),
      });
      registerLeadTools(scoped, disposers);
      registerHandoffTool(scoped, disposers);
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }

    registerHandoffTool(scoped, disposers, ({ artifactPath, at, taskId }) => {
      const records = handoffs.get(agent) ?? new Map();
      records.set(taskId ?? '', { at, artifactPath });
      handoffs.set(agent, records);
    }, flushBudgets);
    const cwd = await callerCwd(ctx, agent);
    await cleanupStaleAtomicTemps(path.join(cwd, '.dsh')).catch((error) => {
      warn(`state temp cleanup for "${membership.name}" failed: ${error.message}`);
    });
    const role = pendingRoles.get(membership.name) ?? (await fallbackRole(cwd, membership.name));
    if (role === null) {
      warn(
        `teammate "${membership.name}" has no matching role; only the message-trust policy and team_handoff are installed`,
      );
      return () => {
        for (const dispose of disposers.reverse()) dispose();
      };
    }
    addSection(ctx, scoped, disposers, {
      name: 'team-plus:role-policy',
      order: sectionBase + 2,
      text: rolePolicyText(role),
    });
    const knownGlobals = new Set(ctx.tools.schemas().map((schema) => schema.name));
    const denied = new Set(role.toolsDeny);
    if (role.toolsAllow.length > 0) {
      for (const globalName of knownGlobals) {
        if (!role.toolsAllow.includes(globalName)) denied.add(globalName);
      }
    }
    const effectiveDeny = [...denied].filter((toolName) => knownGlobals.has(toolName));
    if (effectiveDeny.length > 0) {
      try {
        disposers.push(scoped.tools.restrict({ deny: effectiveDeny }));
      } catch (error) {
        warn(`tool restriction for "${membership.name}" failed: ${error.message}`);
      }
    }
    const handoffDir = path.join(cwd, 'reviews', 'team');
    await housekeepHandoffDirectory(handoffDir, { retentionMs: handoffRetentionMs(process.env) }).catch((error) => {
      warn(`handoff housekeeping for "${membership.name}" failed: ${error.message}`);
    });
    const restoredHandoffs = await findHandoffArtifacts(handoffDir, membership.name);
    if (restoredHandoffs.length > 0) {
      const records = new Map();
      for (const item of restoredHandoffs) {
        const key = item.taskId ?? '';
        if (!records.has(key)) {
          records.set(key, { at: item.at, artifactPath: path.relative(cwd, item.file).replace(/\\/g, '/') });
        }
      }
      handoffs.set(agent, records);
    }
    const persistedBudget = await readRoleBudget(cwd, membership.name);
    const budget = restoreRoleBudget(createBudget, role, persistedBudget);
    budgets.set(agent, budget);
    try {
      disposers.push(
        scoped.tools.guard((execution) => {
          const active = budgets.get(agent);
          if (active === undefined) return undefined;
          if (execution.name === 'team_task_update') {
            const taskId = typeof execution.arguments?.task_id === 'string' ? execution.arguments.task_id : '';
            const handoff = handoffs.get(agent)?.get(taskId);
            const artifactExists =
              handoff !== undefined && typeof handoff.artifactPath === 'string'
                ? existsSync(path.join(cwd, handoff.artifactPath))
                : false;
            const gate = completionGate({
              args: execution.arguments,
              lastHandoffAt: handoff?.at,
              artifactExists,
              now: Date.now(),
            });
            if (gate !== null) return gate;
            if (execution.arguments?.action === 'complete') {
              flushBudgets().catch((error) => warn(`post-complete budget flush failed: ${error.message}`));
            }
          }
          if (TEAM_TOOLS.has(execution.name)) return undefined;
          const decision = decideCall({
            role,
            budget: active,
            toolName: execution.name,
            args: execution.arguments,
            cwd,
            now: Date.now(),
          });
          if (!decision.allowed) return decision.deny;
          recordCall(active);
          persistBudget(cwd, membership.name, active);
          return undefined;
        }),
      );
    } catch (error) {
      warn(`tool guard for "${membership.name}" failed: ${error.message}`);
    }
    warn(`role "${role.name}" installed for teammate "${membership.name}"`);
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  };

  const maybeInstall = async (agent) => {
    if (installed.has(agent)) return;
    if (ctx.agentTeams.tryMembership(agent) === undefined) return;
    installed.set(agent, () => {});
    const dispose = await install(agent);
    installed.set(agent, dispose);
  };

  const cleanupKnownWorkspaces = async () => {
    const workspaces = new Set([ctx.workingDirectory.defaultDirectory]);
    for (const agent of ctx.agents.list()) {
      if (ctx.agentTeams.tryMembership(agent) === undefined) continue;
      try {
        workspaces.add(await callerCwd(ctx, agent));
      } catch {
        // A vanished working directory is not cleanup-worthy.
      }
    }
    await Promise.all(
      [...workspaces].map((cwd) =>
        cleanupStaleAtomicTemps(path.join(cwd, '.dsh')).catch((error) => {
          warn(`startup state temp cleanup failed for ${cwd}: ${error.message}`);
        }),
      ),
    );
  };
  cleanupKnownWorkspaces().catch((error) => warn(`startup state temp cleanup failed: ${error.message}`));
  for (const agent of ctx.agents.list()) {
    maybeInstall(agent).catch((error) => warn(`install for live agent failed: ${error.message}`));
  }
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent).catch((error) => warn(`install for new agent failed: ${error.message}`));
  });
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.();
    installed.delete(agent);
    budgets.delete(agent);
    handoffs.delete(agent);
    flushBudgets().catch((error) => warn(`dispose budget flush failed: ${error.message}`));
  });
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose();
    installed.clear();
    budgets.clear();
    handoffs.clear();
  }, 'agent-team-plus: scoped tools, guards, and prompt sections');
}
