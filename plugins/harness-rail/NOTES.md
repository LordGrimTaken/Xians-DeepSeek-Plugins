# harness-rail — implementation notes

Package: `@local/harness-rail` · bundle row id: `harness-rail` · client module id
`@local/harness-rail` · CSS prefix `hr-` · English-only inline copy.
Everything ships in `client.js` (plain browser script, only `require('react')`).
Files: `package.json`, `index.js`, `client.js`, `cordis.patch.yml`, `README.md`,
`NOTES.md`.

## 1. Slots registered (all inside `ctx.effect` + cleanup)

| Slot | Kind | Registration | Component |
|---|---|---|---|
| `main` | keyed | `{ name:'main', key:'hr-search' }` | `SearchPage` |
| `main` | keyed | `{ name:'main', key:'hr-sessions' }` | `SessionsPage` |
| `main` | keyed | `{ name:'main', key:'hr-customize' }` | `CustomizePage` |
| `main` | keyed | `{ name:'main', key:'hr-activity' }` | `ActivityPage` |
| `sidebar.panellist` | list | `{ id:'hr-search', order:30, label:()=>'Search' }` | `SearchIcon` |
| `sidebar.panellist` | list | `{ id:'hr-sessions', order:40, label:()=>'Sessions' }` | `SessionsIcon` |
| `sidebar.panellist` | list | `{ id:'hr-customize', order:50, label:()=>'Customize' }` | `CustomizeIcon` |
| `sidebar.panellist` | list | `{ id:'hr-activity', order:60, label:()=>'Activity' }` | `ActivityIcon` |
| `shell.bottom` | single | `{ name:'shell.bottom' }` (priority fallback `-1`) | `StatusStrip` |

Shipped panellist orders are 0 (plugins), 10 (schedules), 20 (in-house browser), so
this package appends its four rows after them. Each registration goes through
`ctx.slots.inject(<slot>, () => ctx.slots.register(...))`, i.e. it waits for the
slot declaration (ui-layout / ui-sidebar) and is disposed automatically with the
plugin fiber. The outer `ctx.effect(() => { ...; return cleanup })` also holds
explicit disposers. Registration failures never throw into the fiber: the helper
`registerSafely` logs, retries a single-slot conflict at `priority: -1`, and
otherwise degrades to a no-op disposer.

`inject: ['slots']` is the only hard dependency. Everything else is resolved at
call time with `ctx.get(name)` so a partial composition cannot wedge the plugin.

CSS lives in one `<style>` tag created in `ctx.effect`, with
`data-plugin="@local/harness-rail"` and `data-plugin-css="@local/harness-rail/styles.css"`,
and is removed by the effect's disposer. Every selector is rooted at `.hr-page` or
`.hr-strip`.

## 2. Services and data sources

Framework standard kit (injected by the slot renderer into every root-scope slot,
including `main` and `shell.bottom`):

- `useSessions` — `ctx.sessions.list` snapshot (`SessionListState`: `ids`, `byId`,
  `phase`). Used by Search/Sessions/Customize/Activity/StatusStrip.
- `useWorkspaces` — `ctx.workspaces.list` snapshot (`items[].title`,
  `items[].sessionIds`, `archivedSessionIds`). Used for workspace titles and the
  archived filter.

Client services (via `ctx.get(...)` in the apply closure):

- `uiWorkspace` (`ui-workspace` client service):
  - `openSession(sessionId)` — **primary** way Search/Sessions open a result.
  - `startSession()` — Sessions "New session" / "Start a conversation".
- `layout` (`ui-layout` service): `selectPanel('plugins')` for the Plugins
  Customize card.
- `jobs` (`api-job-controller` client service):
  - `watchRows(currentSessionId)` inside a `useEffect` with release on cleanup,
  - `state` observable (`snapshot.rows[sessionId]` roster) subscribed through a
    local `useObservable` (`getSnapshot` + `subscribe`),
  - `kill(sessionId, jobId)` from the per-row stop button.
- `shortcuts` (`shortcuts` client service): read-only `catalog` snapshot to look
  up the `settings.open` command's normalized binding (see fallbacks below).

## 3. Real values vs. fallbacks (nothing is a hardcoded mock)

Real Client data:

- session catalog rows: `id`, `title` / `displayTitle`, `cwd`, `updatedAt`,
  `running`, `blank`, `retainedBy.mainView`;
- the currently open conversation is the row with `retainedBy.mainView > 0`
  (same rule ui-workspace uses for its selected row);
- **model**: `projectionValues.modelSelection.next || .lastUsed` `{ provider, model }`;
- **token counters**: `projectionValues.tokenUsage`
  (`uncachedInputTokens + cacheReadTokens + cacheWriteTokens` → `in`,
  `outputTokens` → `out`, cache-hit share = `cacheReadTokens / billed input`);
- **context meter**: `projectionValues.contextPressure`
  (`projectedTokens` falling back to `pressureTokens`, over `contextWindow`);
- **activity roster**: `ctx.jobs` `JobView` rows (id, kind, label, status,
  progress, detail, `startedAt`, `output.total`);
- **appearance chip**: read from the applied document (`body[data-ds-dark-theme]`),
  not from a theme service (none is public);
- workspace/project label: session `cwd` basename, then workspace `title`, then
  most recently updated workspace title, else `no workspace`.

DOM-driven fallbacks (only when the public service is unavailable or a surface has
no public navigation API — documented below):

1. **Opening a session** — `ctx.uiWorkspace.openSession` is public and exists in
   this build, so this is primary. Fallback: click
   `[data-row-key="session:<id>"]` (ui-workspace `SessionRow` carries that stable
   attribute). The fallback needs an **expanded** sidebar; in the 56 px rail there
   are no session rows, so with `uiWorkspace` missing the row click is a no-op.
2. **New session** — `ctx.uiWorkspace.startSession`; fallback clicks a
   `button[aria-label]` matching the shipped "New session" labels.
3. **Plugins card** — `ctx.layout.selectPanel('plugins')`; fallback clicks the
   sidebar panel row by its `aria-label` ("Plugins" / localized shorthands).
4. **Settings modal (Appearance / Models / Skills cards, "Open settings")** — no
   public settings-navigation service exists, so:
   - read the `settings.open` catalog entry from `ctx.shortcuts.catalog` and
     **replay its binding as a synthetic `KeyboardEvent('keydown')`** on `window`.
     The shortcuts keyboard adapter (packages/client/shortcuts/src/client/dom.ts)
     does not check `isTrusted`, so the shell's own command runs — this is
     locale-independent and follows a user-remapped binding;
   - if the modal has not appeared after ~180 ms, click the labelled sidebar
     settings trigger (`button[aria-label]` matching the shipped "Settings"
     translations);
   - once open, select a settings section by clicking the nav cell whose visible
     text matches the localized labels for that section (English + the seven other
     shipped locales; if no label matches, the modal stays on its current section —
     no error).
   Trigger labels are the ones shipped by the settings shell; a locale outside
   these tables still succeeds through the shortcut path.

No network requests, no `fetch`, no package-file reads, no localStorage writes.

## 4. Gaps / known limitations

- **No public client API opens Settings or selects a settings section.** The
  synthetic-shortcut + labelled-nav fallback above is the best available path; it
  is intentionally best-effort and silent on failure. The favicon-like "Skills &
  settings" card opens Settings (no dedicated Skills surface exists in this
  build — the skill catalog is only reachable through the composer `/` menu).
- **Search is catalog-only**, by design of the task: it filters title, project
  path, and id. `ctx.sessions.search(query, signal)` (Host message-index search)
  exists but is not used here; adding it would need per-result snippet rendering.
- **`shell.bottom` occupant conflict**: if an `experimental-inspector` build also
  occupies the single slot, the first registration throws and is retried at
  `priority: -1` so this strip wins and the inspector loses its cell; if both are
  pinned at the same priority the retry path logs and the strip is skipped. There
  is no non-conflicting way to host a second single-slot occupant.
- **Activity roster is per session** (`ctx.jobs.watchRows(sessionId)`); with no
  selected conversation there is no roster to watch, so the page shows a clean
  empty state. Unowned jobs appear in the watched session's visible set (the Host
  includes them), so they do show while a conversation is open.
- **Token/context figures are session-summary projection hints.** They are exact
  when the Host has published them, but a list row can lag the live conversation
  until the next list update/reconnect — the same freshness the shipped sidebar
  rows have. Hover titles show the exact raw numbers.
- **Archived sessions are hidden** from Search/Sessions (ui-workspace's archive
  set); there is no unarchive affordance in the rail.
- **Relative timestamps** tick every 30 s from a local clock; they are labels, not
  authority.
- **Localized label tables** (settings trigger/nav, new-session, plugins) cover
  en/zh/ja/es/fr/de/ru/pt, the locales this build ships. An unknown locale falls
  back to the shortcut path (settings) or to an icon-only no-op (other labels).
- **Line count**: `client.js` is 1563 lines — about 1,276 lines of plain-JS
  components/helpers (with JSDoc) plus a 287-line inline CSS template. It exceeds
  the brief's soft "under ~1200" target because it ships four full pages plus the
  status strip; the sibling shell packages are single-surface (~1,100 lines). The
  CSS is formatted two-to-three declarations per line, like the other shell
  packages.

## 5. Visual / layout notes

- Pages are full-size flex columns: fixed header (`26px 40px 14px`), scrolling
  `.hr-scroll` body (`min-height: 0`, thin themed scrollbar), content column
  centred at `max-width: 880px`, optional footer hint row (Search).
- Works from the full sidebar width and from the **56 px icon rail**: the rail
  only renders the icons (the pages live in the centre column), and the bottom
  strip is a full-width row with flexible middle content that collapses counters
  and meters at 1080/900 px viewport widths.
- All colors are `--dsw-alias-*` / `--dsw-specific-sidebar-fill` /
  `--dsw-radius-*` / `--dsw-font-family` tokens; the only literal colors are the
  documented mint alpha overlays (`rgb(78 229 155 / …)`, `rgb(120 229 170 / …)`),
  so light preference stays readable and dark follows the Hadal Mint remap.
- No emoji, no gradients (only the tiny mint prompt text-shadow/glow accents and
  the 3–5 px live-dot pulsing; pulse is disabled under
  `prefers-reduced-motion: reduce`).

## 6. Verification performed

- `node --check client.js` → **passes** (node 24.21.0).
- `node --check index.js` → **passes**.
- SSR smoke harness (temporary, not shipped): executed the real `factory(require)`
  with React 18.3.1 from the checkout's pnpm store, a stubbed `window`/`document`,
  and a ctx stub; asserted the 9 registrations, `data-plugin` style tag, and
  rendered `renderToString` for: all four pages (fixtures with a running current
  session, yesterday/earlier rows, model + token + context projections, two jobs),
  all four rail icons at `size 16/18` and `active` both ways, the status strip, and
  the empty states (no sessions; no jobs service). Teardown removed the style tag
  and ran every disposer without throwing. The temporary harness was deleted.
- `client.js` and `index.js` were not installed into any profile; the Lead wires
  the bundle.

## 7. What the Lead must wire up

1. Add the bundle (`C:\Users\Austin\dsh-plugins\harness-rail`) to the dev profile
   the same way `@local/inhouse-browser` is wired.
2. Its `cordis.patch.yml` inserts exactly one row:
   `id: harness-rail`, `name: '@local/harness-rail'`.
3. Expect four new rail icon rows (orders 30–60) and a 24 px status strip below
   the columns; the four panels open from the rail rows.
4. No host-side services, no config, no migrations.
