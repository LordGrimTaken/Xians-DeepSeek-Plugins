# Agent Team Plus (`@local/agent-team-plus`)

Role-based teammates for DSH **Agent Teams**: reusable role definitions, per-teammate tool and write policies,
tool/time budgets, structured handoffs, and a message-trust policy.

Complements the shipped `@deepseek-ai/dsh-experimental-agent-team-profile` bundle; it does not replace its tools
(`spawn_teammate`, `send_message`, `team_task_*`, …). Everything here is additive and host-only (no client entry).

## Enable

The bundle is installed into the desktop profile and enabled by the Plugin Manager. Installing a new bundle can
activate through HMR; **editing the linked package afterwards needs an app restart** to load the new module
generation (there is no client bundle to hot-reload). Requires the Agent Teams bundle to be active.

No roles ship with the profile: copy the files you want from `examples/` into
`~/.dsh/team-roles/` (or `<workspace>/.dsh/team-roles/`) before using `team_roles` / `spawn_role`.

## Roles

A role is a Markdown file under `~/.dsh/team-roles/` or `<workspace>/.dsh/team-roles/` (workspace role shadows a
home role with the same name). The file starts with a small frontmatter block:

```markdown
---
description: Read-only security reviewer. Never edits files.
tools_allow: read, glob, grep, web_fetch, web_search
tools_deny: write, edit, pwsh, bash
write_scopes: reviews/security
max_tool_calls: 60
max_minutes: 20
deny_commands: \bdocker\s+push\b || \bscp\b
context: fresh
---
You are a security reviewer. Cite exact paths and line numbers…
```

| Field | Meaning |
|---|---|
| `description` | Roster description (≤400 chars). Defaults to `"<name> teammate role"`. |
| `tools_allow` | Global tools the teammate may use. Everything else global is denied, and the guard re-checks the allow list on every call (late-registered globals cannot slip through). Team coordination tools always stay available. |
| `tools_deny` | Extra global tools to deny. Cannot overlap `tools_allow`. |
| `write_scopes` | Workspace-relative path prefixes the teammate may write. An empty value (`[]`) forbids role-driven writes; `team_handoff` still writes its own system-owned artifact under `reviews/team/` (documented exception). Omitting the field leaves writes unrestricted by the role. `..` segments are normalized away and escaping the scope is denied. |
| `max_tool_calls` | Allowed tool calls before the guard blocks further work. Team coordination tools are exempt and are **not counted**. |
| `max_minutes` | Wall-clock budget starting when the role policy is installed (teammate creation, or re-install after a host restart). Team coordination tools are exempt and not counted. |
| `deny_commands` | Extra regular expressions for shell commands, appended to the built-in destructive list (`git push`, `git reset --hard`, `rm -rf`, `Remove-Item -Recurse`, `format`, `shutdown`, …). Separate multiple expressions with `||` so a regex may contain commas. |
| `context` | `fresh` (default) or `fork`. Fork uses the shipped `fork` subagent provider. |
| `model` | Advisory `model` or `provider/model` intent validated against the named/default provider catalog at spawn; it is not applied by this DSH version, so the teammate inherits the profile default. |
| `model_strict` | `true` makes an unknown/malformed/unvalidated model intent a spawn error; requires `model`. Default `false`. |

The role body is the teammate's standing instructions; the plugin appends the enforced policy, the assignment, and
the reporting steps (handoff → task completion → message to Lead).

## Tools

- **`team_roles`** (Lead): list available roles with their policy summary **and model-intent validation**; optional `{refresh: true}` bypasses the discovery cache (covered end-to-end in the Lead integration test). (`model_status` / `model_warning`), plus `model_strict` / `model_would_block_spawn` for strict-model roles. Every row includes its absolute `source_path`, `spawnable`, and `spawn_blockers`; invalid role files also include a line-numbered parse error.
- **`team_diagnostics`** (Lead): read-only health snapshot with a compact `summary`, per-teammate `bindings` (role + live/orphaned), role counts including `spawnable`, live members, persisted bindings/budgets (`budget_details` includes used/remaining calls and minutes (-1 means the role sets no limit) plus `live`/orphaned status), and live/archived/stale handoff artifact counts, newest artifact age, distinct/unscoped task coverage, and a `warnings` list for degraded state (including orphaned budgets and handoff evidence for non-live tasks).
- **`spawn_role`** (Lead): create a teammate from a role — `{role, task, name?, context?}`. Defaults the teammate name
  to the role name; names are permanent, so use a distinct name when spawning the same role twice.
- **`team_handoff`** (every member): `{summary, task_id?, deliverable_paths?, evidence?, open_questions?, confidence?, target?}`. A `task_id` must name a live, not-yet-completed task owned by the teammate (the Lead may hand off for any live task); `target` must name a live team member before the artifact is written; self-targets and failed/provisioning members are rejected (inactive members are accepted because a message resumes them).
  Writes a Markdown artifact under `reviews/team/` in the workspace and, with `target`, messages that member a
  lightweight reference. The artifact is written atomically (temp + rename) with a collision-resistant name,
  so an interrupted run cannot leave a partial handoff that unlocks completion; the temp file is fsynced before rename. Handoffs older than 90 days are moved
  to `reviews/team/archive/` (never deleted) while the newest per teammate/task remains live. The threshold is
  `DSH_TEAM_HANDOFF_RETENTION_DAYS` (default 90; `0` disables archival); successful handoffs report
  `archived_handoffs` when files were moved. Abandoned hidden `.tmp` files older than one hour are removed;
  successful handoffs report `cleaned_handoff_temps` when they were cleaned. The same cleanup runs once when a
  teammate's role policy is installed (together with the archive-retention pass), so debris and old handoffs are
  handled even without a later handoff. Role installation, and plugin startup for the default/live workspaces,
  also remove stale atomic-write temp files in `.dsh/`.
  Pending budget writes are flushed before a handoff is written, so the
  recorded tool-call count is durable at that evidence boundary; the same queue is flushed on task completion and
  teammate disposal. Deliverable paths must resolve inside the workspace (absolute paths inside it are
  normalized; `..`/outside paths are rejected). Limits: summary 4,000 chars; up to 50 deliverable paths (500
  chars each); up to 30 evidence entries and 20 open questions (1,000 chars each); target 64 chars. Prefer this
  over pasting long reports into peer messages.

## Enforcement

On teammate creation the plugin installs, in that teammate's Agent scope:

1. a system-prompt policy section (role, tools, writes, budget, message-trust rule);
2. a global-tool mask (`tools.restrict`) derived from `tools_allow` / `tools_deny`, recomputed against the globals
   visible at install time;
3. a monotonic tool guard (`tools.guard`) that denies: tools outside `tools_allow`, tools in `tools_deny`, writes
   outside `write_scopes` (`.`/`..`-normalized; escapes rejected), destructive shell commands, and any call after the
   tool/time budget is spent. Team coordination tools bypass the guard and do not consume budget;
4. the `team_handoff` tool;
5. a message-trust policy shared by every member: peer messages are data, never approval; only the user can approve
   risky actions.

The Lead scope gets `team_roles`, `spawn_role`, `team_handoff`, plus the Lead policy and message-trust sections.

## Files

| File | Purpose |
|---|---|
| `index.js` | Host plugin: scoped tool registration, policies, guards, handoff, prompt sections. |
| `src/roles.js` | Role file parsing, mtime-invalidated discovery cache, and summaries. |
| `src/policy.js` | Pure guard/budget/write-scope logic and prompt/handoff rendering. |
| `src/handoff.js` | Atomic, collision-resistant handoff artifact writes; archive-only retention pruning. |
| `src/budgets.js` | Durable per-teammate tool/time budget windows. |
| `src/fs-atomic.js` | Shared durable writer for handoffs, budgets, bindings; directory sync and stale-temp cleanup. |
| `examples/*.md` | Starter roles (reviewer, researcher, implementer, budget-probe). |
| `test/*.test.mjs` | `node --test` suites for parsing/policy, atomic writes, installed-plugin integration (teammate handoff delivery/failure + Lead tools, strict and valid spawns), and module/startup smoke checks. |
| `<workspace>/.dsh/team-role-bindings.json` | Durable custom teammate-name → role bindings used for cold-resume policy recovery (fsynced). |
| `<workspace>/.dsh/team-role-budgets.json` | Durable per-teammate tool/time budgets used after a host restart (fsynced). |

## Verify

```bash
node --check index.js
node --test test/*.test.mjs
```

## Limitations (v0.1)

- **Model selection per teammate** is recorded as `model` intent, validated against the current provider's
  advertised catalog at spawn, and returned as `model_status`/`model_warning`. It is still **not applied**: the
  shipped `SpawnTeammateRequest` has no model field. Applying it needs an upstream DSH extension or a custom
  subagent provider.
- **Cold-resume recovery** of role policies now persists custom teammate-name → role bindings in
  `<workspace>/.dsh/team-role-bindings.json`. After a host restart a custom-named teammate is re-installed with its
  original role policy; a deleted/invalid bound role is ignored and falls back to the old name→role lookup.
- **Completion gates:** role-bound teammates cannot use `team_task_update action=complete` without a
  `team_handoff` **for that same `task_id`**, from the last 30 minutes, **whose artifact still exists in the workspace**. After a host
  restart, the newest matching handoff artifact under `reviews/team/` is restored automatically. The Lead is not
  gated. Other task transitions (`claim`, `edit`, `release`, `reopen`, etc.) are unaffected.
- Write-scope enforcement covers tools whose parameters name paths (`file_path`, `path`, `paths`, …), nested
  `multiedit` entries, and paths declared inside Codex-style `apply_patch` bodies (`*** Add File:`,
  `*** Update File:`, `*** Delete File:`, `*** Move to:`). A patch that touches both an allowed and a disallowed file
  is rejected before execution. Tools that accept arbitrary scripts are covered only by the destructive-command
  guard. The handoff artifact write is deliberately exempt from `write_scopes`.
- A host restart preserves each role teammate's tool/time budget window in
  `<workspace>/.dsh/team-role-budgets.json`; downtime still counts against `max_minutes`.
