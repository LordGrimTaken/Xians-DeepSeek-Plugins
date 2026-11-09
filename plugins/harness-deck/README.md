# @local/harness-deck

Lamprey-style right workspace deck for the DeepSeek Harness Web UI: six
right-Sidebar page types with rich guide cards, plus two one-time boot
behaviours (auto-open the right column and nudge its width toward the Lamprey
reference). Client-only; the Host half is an empty stub.

```
package.json          bundle manifest (dsh.bundle patch + dsh.client web)
index.js              host half: export function apply() {}
client.js             browser half: plain script through window.__ModuleLoader__
cordis.patch.yml      inserts the `harness-deck` plugin row
README.md             this file
NOTES.md              exact APIs used, real vs fallback, wiring notes
```

## What it adds to the right Sidebar

| Guide card | Kind | What the page does |
|---|---|---|
| Side chat | `harness-side-chat` | Branches the current conversation with the public workspace `forkSession` service and can open the new session. |
| Artifacts | `harness-artifacts` | Shows the session workspace path (live from the session catalog) and deep-links to the shipped `files` tab. |
| Review | `harness-review` | Honest turn-review page: explains that a review opens from a turn's changed-files card (the shipped review kinds are address-driven), offers a real Files deep link, and opens a page-type review tab if one is ever registered. |
| Plan | `harness-plan` | Live plan-mode state and the agent's todo checklist from public session projections; toggles plan mode through the public `/plan` command when reachable. |
| Background tasks | `harness-background-tasks` | Live job roster from the client `jobs` service: status, progress, duration, two-press stop. |
| Reasoning trace | `harness-reasoning-trace` | Live trajectory stage counts and request rows, plus an action that switches the conversation to the Trajectory view. |

Guide ordering against the shipped cards: `files` (10), **Side chat (15)**,
`terminal` (20), `browser` (30), **Artifacts (35)**, **Review (40)**,
**Plan (45)**, **Background tasks (80)**, **Reasoning trace (90)**.

## Install

The Lead installs this package into a DSH profile; do not install it directly.
The bundle is a normal DSH client-only plugin:

- `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts one plugin row
  with id `harness-deck` and name `@local/harness-deck`.
- `dsh.client` marks the browser half `web` + `immediately`, so it loads in the
  first client batch.
- The client module requires only `react`; there are no npm dependencies, no
  JSX, and no ES imports.

## Requirements at runtime

Only three services are required for activation: `slots`, `sidebarRightTabs`,
`sidebarRight`. Optional services and standard hooks are resolved lazily per
action, so a composition without `uiWorkspace`, `jobs`, `ui-trajectory`,
`remote.commands`, or the `plan`/`todos` projections still loads and renders a
graceful page state instead of failing to activate.

## Styling

One `<style data-plugin="@local/harness-deck" data-plugin-css="…/styles.css">`
tag, removed on unload. Theme tokens only (`--dsw-alias-*`, `--dsw-radius-*`,
`--dsw-font-family`), with the mint alpha overlays the build brief allows.
Every selector is scoped by an `hd-` class.
