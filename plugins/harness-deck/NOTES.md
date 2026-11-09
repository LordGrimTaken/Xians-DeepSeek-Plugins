# harness-deck — build notes, exact APIs, real vs fallback

Package: `C:\Users\Austin\dsh-plugins\harness-deck`
Plugin row id: `harness-deck` (package `@local/harness-deck`)
Files: `package.json`, `index.js` (host stub), `client.js`, `cordis.patch.yml`,
`README.md`, `NOTES.md`
`client.js`: 1378 lines, `node --check` exit 0, `index.js` check exit 0.

Not installed into any profile — the Lead installs and verifies visually.

---

## 1. Exact services / slots / DOM surfaces used

### Plugin injection (activation-gating)

```js
inject: ['slots', 'sidebarRightTabs', 'sidebarRight']
```

These are the only required services. Everything else is read lazily with
`ctx.get(name)` inside action handlers, so a missing optional service degrades
the page instead of parking the whole plugin.

- `ctx.effect(cb, label)` — every registration, the style tag, and both boot
  behaviours run inside an effect whose disposer is returned.
- `ctx.get('uiWorkspace')` → `ctx.uiWorkspace.forkSession(sessionId)` and
  `ctx.uiWorkspace.openSession(sessionId)` for the Side chat page.
- `ctx.get('jobs')` → `ctx.jobs.state` (bare `getSnapshot`/`subscribe` source),
  `ctx.jobs.watchRows(sessionId)`, `ctx.jobs.kill(sessionId, jobId)` for
  Background tasks.
- Global slot standard prop `useSessions` on session-scoped tab bodies — reads
  `byId[sessionId]` for `displayTitle`, `cwd`, `blank`.
- Global slot standard prop `useProjection(key)` — `useProjection('plan')` gives
  the live `{ active, pending }` plan-mode projection and `useProjection('todos')`
  gives the agent's current `TodoItem[] | null` checklist (both declared by the
  Host plugins and delivered through `ui-session`'s standard kit). Only used
  inside a child component mounted when the hook is present.
- Lazy `ctx.get('remote.commands')` / `ctx.get('remote').commands` →
  `commands.execute(sessionId, '/plan' | '/plan off', [])`, the public command
  Remote the shipped plan chip uses; the Plan page toggles plan mode through it.
- Global slot standard prop `useTrajectory` (contributed by
  `ui-trajectory` through `uiSession.provide`) — live `requests`,
  `runningCalls`, `eventNodes` for Reasoning trace. Only used when present, and
  only inside a child component, so a build without the trajectory plugin never
  calls the hook.
- `ctx.sidebarRight.mounted` (observable), `isExpanded()`,
  `toggleExpanded()` — one-time auto-open.
- `document.querySelector('[data-conversation-tabs] button[role="tab"]')` —
  presses the Trajectory view tab for Reasoning trace. No public command or
  service switches a conversation view.
- `ctx.sidebarRightTabs.get(kind)` — checks whether a shipped kind exists before
  enabling a deep link; `definition.patterns` is also used to tell a **page**
  type (opens by kind) from an **address-driven resource viewer** (a page open
  would mint an address its body rejects — see Review).
- `ctx.sidebarRight.openTab(kind)` — opens the `files` tab (Artifacts, Review)
  and any page-type review/plan kind when registered.

### Tab types (stage one) — 6 registrations, each in `ctx.effect`

```js
ctx.sidebarRightTabs.register({
  id, kind, priority: 'extension',
  title: () => string,
  guide: [{ id: 'card', order, title: () => string,
            description: () => string, icon: Component }],
})
```

| id | kind | guide order |
|---|---|---|
| `@local/harness-deck/side-chat` | `harness-side-chat` | 15 |
| `@local/harness-deck/artifacts` | `harness-artifacts` | 35 |
| `@local/harness-deck/review` | `harness-review` | 40 |
| `@local/harness-deck/plan` | `harness-plan` | 45 |
| `@local/harness-deck/background-tasks` | `harness-background-tasks` | 80 |
| `@local/harness-deck/reasoning-trace` | `harness-reasoning-trace` | 90 |

### Page bodies (stage two) — 6 registrations, each in `ctx.effect` + `ctx.slots.inject`

```js
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: type.id,                         // = the type definition id
    inject: () => ({ deck, type }),       // business face + page catalogue entry
  }, type.body)))
```

Bodies receive the framework standard props (`sessionId`, `useSessions`,
`useProjection`, `useTabInfo`, …) plus `deck` / `type`. `deck` is the one shared
action face (fork/open/tab/jobs/trajectory/plan command/page-kind probe) built
from the plugin `ctx`.

### Guide cards — 6 registrations, each in `ctx.effect` + `ctx.slots.inject`

```js
ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
  ctx.slots.register({ name: 'sidebar.right.tab.guide.entry', key: type.id },
                     makeGuideCard(type))))
```

Keyed by the definition id, which is what the shipped guide dispatches on
(`entry.providerId`). Each card is a real `<button class="hd-guide-card">` with
icon tile + title + description + chevron; on press it calls
`useTabInfo().tab.actions.openTab(kind, { replaceTab: true })` and then
`tab.actions.close()`, exactly like the shipped guide's own entry boxes.

---

## 2. What is REAL vs FALLBACK

| Surface | Status | Details |
|---|---|---|
| Side chat → Create / Open | **REAL** | `ctx.uiWorkspace.forkSession(sessionId)` (public navigation service) returns the child `SessionId`; "Open side chat" calls `ctx.uiWorkspace.openSession(childId)`. Failure classification matches `SessionForkError` + `rpcError.code === 'session/fork-unavailable'` (blank / no completed turn) with a distinct message, everything else a generic error. Blank sessions from the session catalog disable the action up front. |
| Artifacts → workspace path | **REAL** | `useSessions(s => s.byId[sessionId].cwd)` from the live session catalog. |
| Artifacts → Browse files | **REAL deep link** | `ctx.sidebarRight.openTab('files')`, guarded by `ctx.sidebarRightTabs.get('files')`. |
| Artifacts → per-session artifact inventory | **FALLBACK (documented on the page)** | No public client service exposes "files produced this session"; the page says so and deep-links to the Files tab instead of guessing. The Review tab is mentioned but not deep-linked: `changes-review` needs turn coordinates, and ui-deliverables' own cards are the only public opener. |
| Review → page | **HONEST EXPLAINER + conditional page open** | The shipped review kinds are **address-driven resource viewers** (`changes-review` in ui-deliverables, `forge-changes` in experimental forge: both declare `patterns` and their bodies `throw` for a page address like `sidebar://harness-review`), so the page does **not** call `openTab('changes-review')` — that would mint an address its body rejects. It probes `ctx.sidebarRightTabs.get(kind)` for a **page-type** review kind (`patterns` absent) and enables "Open Review tab" only then; otherwise the primary action is disabled with "Review opens from a turn's changed-files card", plus a real "Browse files" secondary action. This is a deliberate, documented deviation from the literal "call openTab(kind)" instruction for safety. |
| Plan → plan-mode state | **REAL** | `useProjection('plan')` (public session projection from `dsh-plan-mode`) → `active` / `pending`; the page states whether planning guidance is on, off, or settling. |
| Plan → checklist | **REAL** | `useProjection('todos')` (public session projection from `dsh-tool-todo`) → the agent's current `TodoItem[]` with pending / in_progress / completed dots; `null` renders "No checklist yet", key absent renders "Checklist unavailable". |
| Plan → toggle plan mode | **REAL** | `ctx.get('remote.commands').execute(sessionId, '/plan' or '/plan off', [])`, the same public command path the shipped plan chip uses; failures/refusals are surfaced, never swallowed. |
| Plan → plan preview tab | **HONEST, not offered** | The shipped `plan` kind is address-driven (`dsh-resource://plan/**`); the page opens it by kind only if a future page-type plan kind exists, and otherwise says the preview opens from a submitted-plan transcript card. |
| Background tasks → roster | **REAL** | `ctx.jobs.state` + `ctx.jobs.watchRows(sessionId)` while mounted; live status dots, progress/detail, ticking duration, two-press stop → `ctx.jobs.kill(sessionId, jobId)` (admission result surfaced on refusal). |
| Background tasks → no job controller | **FALLBACK** | Graceful warning page; the plugin still activates because `jobs` is not in `inject`. |
| Reasoning trace → stage counts/rows | **REAL** | `useTrajectory` standard prop (registered by `ui-trajectory`); counts of stages/live/records and up to six recent `requests` rows (turn.step, purpose, duration, status, error head). |
| Reasoning trace → "Open Trajectory view" | **REAL action, DOM fallback surface** | No public command/service switches a conversation view. The action presses the real Trajectory view tab in `[data-conversation-tabs]` (a data attribute the shell uses for window-chrome geometry, so it is stable). If the strip or tab is absent (global main panel, tab overflow into "More views"), the page reports that instead of failing. English label match only. |
| Reasoning trace → no trajectory plugin | **FALLBACK** | Explainer page with the same action; no hook calls are made. |
| Auto-open right sidebar | **REAL** | Subscribes `ctx.sidebarRight.mounted`; when the first session appears and `isExpanded()` is false, calls `ctx.sidebarRight.toggleExpanded()` once per page load (`deckAutoOpened` module flag). A bounded 250 ms retry (≤40) covers the store-minting race; a session shown much later is caught by the subscription. It never re-opens after a manual collapse. |
| Right-panel width nudge | **REAL, DOM-driven (Lead-provided design)** | `nudgeRightPanelWidth()` reads the frame's inline `grid-template-columns` (`minmax(0px, <N>px)` = current right-column max), and if `N > 480` dispatches one synthetic `pointerdown → pointermove → pointerup` drag of `N - 384` px on `[class*="_handle"][data-side="rightbar"]`, shimming `setPointerCapture` / `releasePointerCapture` / `hasPointerCapture` on `Element.prototype` inside a `try/finally`. Runs at most once per page load (`deckWidthNudged`), retried at 800/1600 ms up to 8 tries until the handle exists, and additionally triggered 250 ms after the one-time auto-open (covers a session shown after the retry window). Suppressed in fullscreen (`data-rightbar-fullscreen`), and skipped when the width is already ≤ 480 (persisted preferences). Target constant `DECK_WIDTH = 384`. |

No service is required beyond `slots` / `sidebarRightTabs` / `sidebarRight`, so
a lean composition still loads.

---

## 3. Visual / behaviour notes

- Guide cards: `hd-guide-card`, 20px radius (`--dsw-radius-xl`), layer-2 fill,
  mint 12% hairline, 38px icon tile with mint 8% fill, title 13px/500,
  description 11px tertiary, dim `›` chevron. Hover: interactive-bg-hover +
  mint 22% border.
- Page shell: 38px icon tile, 14px title, 12px tertiary subtitle, section
  labels uppercase 11px / .08em, cards layer-2 + mint 12% hairline + 12px
  radius, primary button on `--dsw-alias-state-business-primary`.
- All colours are `--dsw-alias-*` tokens (readable in light and dark); the only
  raw values are the mint alpha overlays `rgb(120 229 170 / …)` and
  `rgb(78 229 155 / …)` the brief allows, plus 0.5px hairlines.
- `client.js` is 1378 lines; the build brief's soft target is ~1200. The
  original four-page plugin was 1149 lines and the two post-brief parity pages
  (Review, Plan) plus their CSS/guide icons are the difference. CSS is a single
  template literal near the top; JS cannot reach it from outside the plugin.
- No emoji; English strings inline (no `locale` injection needed).

---

## 4. What the Lead must wire / verify

1. **Install** the bundle into the target profile (do not copy my notes): add
   the package the same way `inhouse-browser` is installed, with the
   `cordis.patch.yml` row `harness-deck` → `@local/harness-deck`. The patch row
   must be the only inserted row and the package must be visible under
   `dsh.bundle`.
2. **Verify the right panel auto-opens once** on a fresh boot with a session
   selected. Then collapse it manually and switch sessions: it must stay
   collapsed (by design, once per page load).
3. **Verify the width nudge** on a desk-width window: open the right panel,
   reload; the column should settle at 384px instead of the shipped 45%
   (≈864px at 1920). It must not run in fullscreen, and a reload after the
   nudge must not drag again (persisted preference wins).
4. **Verify guide cards**: on the sidebar guide page, six new cards appear in
   the order Files, Side chat, Terminal, Browser, Artifacts, **Review**, **Plan**,
   Background tasks, Reasoning trace. They open in place of the guide and the
   guide closes.
5. **Spot-check the six pages** with a real session: branch a conversation from
   Side chat; run a background bash command for Background tasks; open a file
   for Artifacts; use Reasoning trace's "Open Trajectory view"; on Review use
   "Browse files" (the page-type button is correctly disabled in this build);
   on Plan check the plan-mode readout, toggle plan mode with `/plan`, and see
   the checklist from the agent's todo writes.
6. **Risks to watch** (all documented above):
   - The width nudge synthesises pointer events on the frame handle; if the
     shell changes its handle markup (`[class*="_handle"][data-side="rightbar"]`)
     or stops serialising `grid-template-columns` inline, the nudge silently
     no-ops (it is guarded, not fatal).
   - The Trajectory switch is a DOM click on the English view-tab label. If the
     tab is folded into "More views" or the UI is non-English, it reports
     "not visible" rather than switching.
   - The guide replacement only covers the six deck kinds; the shipped
     Files/Browser/Terminal cards keep the shipped compact card style (the
     shipped guide drops descriptions above four entries) — this is deliberate:
     the deck does not restyle other packages' cards.
   - Review deliberately does not `openTab('changes-review' | 'forge-changes')`:
     both are address-driven resource viewers whose bodies throw for a page
     address. A future *page-type* review kind would enable the button through
     the `patterns` probe. Plan likewise opens by kind only for a page type.
   - The Plan toggle executes `/plan` / `/plan off` through the public command
     Remote; like any command this is a real mode change, and its result is
     reported on the page.
   - `useTrajectory` is assumed stable for the lifetime of a session slot; a
     mid-session plugin unload/reload of `ui-trajectory` would change the hook
     identity. The hook calls live in a child component that mounts/unmounts
     with presence, which keeps hook order safe.

---

## 5. Local verification performed (no install)

Three throwaway Node harnesses (React 18 SSR + stubbed module
loader/Cordis/DOM, kept outside the package and deleted afterwards) were run:

1. **Registration/SSR harness** — evaluated `client.js` through a stubbed
   `window.__ModuleLoader__`, ran `apply(ctx)` against a fake context, then
   SSR-rendered every page and guide card with real React 18. Checks passed:
   6 types / 6 bodies / 6 guide cards, ids and kinds, guide keys/orders
   (15 → 35 → 40 → 45 → 80 → 90), every registration inside `ctx.effect`, one
   `data-plugin` style tag with `data-plugin-css`, token-only CSS with only
   `hd-` classes, auto-open exactly once and never after a manual collapse, and
   all pages/cards rendering (including the blank-session, no-trajectory and
   no-job-controller fallbacks), plus clean unmount (style tag removed,
   subscription released).
2. **Width-nudge harness** — synthetic frame/handle: fullscreen attempt
   suppressed, retry after leaving fullscreen dispatched exactly one
   `pointerdown → pointermove → pointerup` with a 480px delta (864 → 384) at the
   handle's vertical centre, `Element.prototype` capture methods restored
   afterwards, and no second drag on later retries.
3. **Review + Plan harness** — separate pass on the final file: six registered
   types in the Lamprey order, Review renders the honest disabled state when
   only address-driven review kinds exist (and an enabled "Open Review tab"
   when a page-type kind is injected), Plan renders live plan-mode state,
   the todo checklist with statuses, the settling state, the empty-checklist
   state, and the no-projection-hook fallback, plus all six guide cards.
