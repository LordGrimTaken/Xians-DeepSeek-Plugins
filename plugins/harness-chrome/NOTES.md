# harness-chrome — build notes

Lamprey-style header command tabs for the DeepSeek Harness Web UI, delivered as
the client-only bundle `@local/harness-chrome` (CSS prefix `hc-`, package dir
`C:\Users\Austin\dsh-plugins\harness-chrome`). Nothing outside this package was
modified and nothing was installed into a profile.

## 1. What was built

- One React surface (`MenuBar`) registered into the header's leading seat:
  `File · Edit · View · Window · Help`, in Lamprey's order, present in both the
  session and the no-session state (the slot is root-scoped and always mounted).
- Each tab opens a dropdown menu whose rows run real actions through public
  client surfaces (see the matrix in §3). Rows that cannot be satisfied are
  rendered `aria-disabled` with the reason in `title` instead of silently
  vanishing.
- Below **900px** of header width the whole strip collapses to a single `⋯`
  button holding one menu with `File/Edit/View/Window/Help` section headings
  and the same 13 actions. This bounds the strip's width so it can never push
  the title row: the strip is `flex: none` inside the header's `auto` grid
  column, while the title column is `minmax(0, 1fr)` and simply shrinks.
- Menu mechanics: click toggles, outside `pointerdown` closes, Escape closes and
  returns focus to the tab, ArrowUp/ArrowDown move rows, Home/End jump,
  Enter/Space activate, ArrowLeft/Right walk across menus, Tab closes. Roles
  are `menubar`/`menu`/`menuitem`/`separator`; tabs carry
  `aria-haspopup="menu"` + `aria-expanded`; rows are `aria-disabled` when
  unavailable; roving `tabIndex` keeps one focus stop per menu.
- Styling: 11.5px monospace on a 26px strip (24px tab buttons), 12.5px menu
  rows, `--dsw-specific-menu` + `var(--dsw-elevation-panel)` +
  `var(--dsw-menu-backdrop-filter)`, 12px radius, 4px popup padding, 8px row
  radius. Only `--dsw-alias-*`, `--dsw-specific-menu`, `--dsw-elevation-*`,
  `--dsw-radius-*`, `--dsw-font-family` and mint alpha overlays
  (`rgb(78 229 155 / …)`) are used, so dark and light preferences both read
  correctly. All CSS lives in one `<style data-plugin>` tag created inside a
  `ctx.effect` and removed by its cleanup.
- Two local panels (never product DOM): **Keyboard Shortcuts** fallback (top-10
  catalog commands with keycaps) and **About** (version/commit from the public
  boot graph, runtime/platform, plugin version, copy-details). They use
  `role="group"`, not `role="dialog"`, so they do not register as modals.

## 2. Slots and services used

Registration (inside `ctx.effect(..., 'harness-chrome: header menu tabs')`):

```js
ctx.slots.inject('conversation.header.leading', () =>
  ctx.slots.register(
    { name: 'conversation.header.leading', inject: () => ({ pluginCtx: ctx }) },
    MenuBar,
  ))
```

- Slot: `conversation.header.leading` — `kind: 'single'`, `scope: 'root'`,
  owner props `{}`. Rendered by `ConversationHeader` for every conversation
  state; verified no other package registers into it today.
- `inject: ['slots']` only. Every other service is read lazily through
  `ctx.get(name)` so a missing/removed package degrades a row instead of
  preventing the plugin from loading:
  - `ctx.layout.toggleSidebar()` / `ctx.layout.selectPanel(id)`
    (`ui-layout`, `ILayout`),
  - `ctx.sidebarRight.isExpanded()` / `toggleExpanded()` / `mounted`
    (`ui-sidebar-right`, `ISidebarRight`),
  - `ctx.uiWorkspace.startSession()` (`ui-workspace`, `UiWorkspace`),
  - `ctx.pluginNavigation.openList()` (`ui-plugin-manager` service),
  - `ctx.shortcuts.catalog.getSnapshot()` (`shortcuts`, `ShortcutCatalogEntry[]`:
    `id`, `label`, `keys`, `binding.code`, `binding.modifiers`,
    `binding.secondCode`, `conflicts`, `issue`).
- DOM contracts relied on (all read-only, no foreign DOM mutation except the
  transient role swap described in §4):
  - `[data-sidebar-collapsed]` on the frame (`ui-layout/AppFrame.tsx`) to read
    whether the left sidebar is currently collapsed — `ctx.layout` exposes a
    toggle but no state getter.
  - `[data-slot="settings.launcher"] button` (rendered by ui-settings-general's
    `settings.launcher` seat) as the labelled control that opens Settings, used
    before the command re-dispatch path.
  - `[data-copy-version]` in the sidebar brand as a fallback source for the
    build version when `window.__DSH_BOOT__.release` is absent.
  - `window.__DSH_BOOT__.release = { version, commit? }` (public boot graph) for
    About.
  - `document.documentElement.dataset.platform` to tell Desktop from Web: the
    Desktop keyboard bridge owns configurable commands, so no synthetic DOM
    gesture is attempted there.
- Browser APIs: `navigator.clipboard.writeText` (with `execCommand('copy')`
  fallback), `document.fullscreenElement` / `requestFullscreen` /
  `exitFullscreen`, `location.reload`, `window.getSelection` + `Range` for the
  composer-draft selection.

## 3. Action matrix (verified against the checked-out DSH sources)

| Row | Binding | Status | Note |
|---|---|---|---|
| File → New Session | `ctx.uiWorkspace.startSession()` (fallback: `session.new` command) | **works** | Opens/reuses the Workspace blank exactly like the sidebar's New Session control. |
| File → Open Plugins | `ctx.pluginNavigation.openList()` (fallback: `ctx.layout.selectPanel('plugins')`) | **works** | Plugin manager ships as a base bundle here; without it the row is disabled ("Plugins page unavailable"). |
| File → Open Settings | click the labelled `[data-slot="settings.launcher"]` button (fallback: re-dispatch `settings.open`) | **works** | Uses the product's own settings trigger, so it works in Web and Desktop; disabled only when neither the launcher nor the command exists. |
| Edit → Find Sessions | re-dispatch of the public `session.search` command | **works** | The workspace browser expands the sidebar, expands search and focuses its input itself. |
| Edit → Copy Selection | `navigator.clipboard.writeText` | **works** | The page selection is captured on the tab's `pointerdown` (before mousedown can collapse it); disabled when nothing is selected. Degrades to `execCommand('copy')` when the async clipboard API is denied. |
| Edit → Select Composer Draft | DOM `Range` over the first visible contenteditable in `<main>` | **degraded** | Selects the composer text at the DOM level only; it never writes editor/model state, so it is safe, but it does not update a rich editor's internal selection model. Disabled ("Composer not found") when no composer is mounted. |
| View → Toggle Left Sidebar | `ctx.layout.toggleSidebar()` | **works** | — |
| View → Toggle Right Sidebar | `ctx.sidebarRight.toggleExpanded()` | **works with a session / unavailable without** | The service throws without an on-screen session whose store is adopted, so the row is disabled ("No Session on screen") instead. |
| View → Reload Page | `location.reload()` | **works** | — |
| Window → Toggle Fullscreen | Fullscreen API on `documentElement` | **works in the browser; degraded in Electron desktop** | `document.fullscreenEnabled === false` disables the row; a rejected `requestFullscreen()` is caught and only logged. |
| Window → Collapse Both Sidebars | left: `ctx.layout.toggleSidebar()`; right: `ctx.sidebarRight.isExpanded()`/`toggleExpanded()` | **works** | Left state comes from the frame's `[data-sidebar-collapsed]` attribute (no public getter exists); disabled when both are already collapsed. |
| Help → Keyboard Shortcuts | Web: re-dispatch of the public `shortcuts.open` command → real `ShortcutReference` overlay. Desktop: local fallback panel | **works on Web; degraded on Desktop** | Desktop routes configurable commands through its native keyboard bridge, so the overlay cannot be opened by a DOM gesture there; the local panel (top-10 catalog commands, "Open Settings" footer) is shown instead. On Web the fallback panel appears only if the command is absent/unbound/conflicted. |
| Help → About | boot-graph release + rendered brand fallback | **works** | Version, commit, runtime, platform, plugin version; "Copy Details" uses the clipboard helper. |

`node --check client.js` **exits 0**.

## 4. Command re-dispatch and the `role="menu"` modal trap

`ctx.shortcuts` publishes the command catalog (including each effective
`binding`) but has **no public `invoke()`**. The only public way to run a
command owned by another plugin is to feed its own binding back through the
keyboard adapter, so command rows look up the catalog row and dispatch one
synthetic `KeyboardEvent('keydown', { code, modifiers… })` on `window`. Rows
whose command has no binding, has `secondCode` (two-stroke sequence), an
`issue`, or `conflicts` are treated as unavailable.

One wrinkle: `ui-primitives`' `modalSelector` is
`'[role="dialog"][aria-modal="true"], [role="menu"]'`, so the open dropdown
itself would count as a modal to the shortcut layer and block e.g.
`shortcuts.open` / `settings.open` (`resolve` checks `modal`). Two mitigations:

1. Before any row action runs, the popup's `role` is switched to
   `presentation` for the synchronous dispatch (the shortcuts listener
   invalidates its modal cache from the mutation record and re-queries), then
   restored. This is why command-backed rows work from inside the menu.
2. While the menu is open, a document-capture keydown listener treats any key
   that is not menu navigation as "close the menu" and, for
   Ctrl/⌘/Alt combinations, unmarks the popup for exactly that event, so
   global shortcuts such as `Ctrl+N`/`Ctrl+K` still run with the menu open.

Plain (modifier-less) commands that check for modals while the menu is open are
still blocked for that instant — an acceptable edge case, documented here.

## 5. Gaps, risks and things the Lead should know

- **No public command API.** The synthetic-keydown mechanism is the only
  cross-plugin invocation path. It depends on each owning plugin keeping its
  default/effective binding resolvable and on the shortcut layer's modal model;
  both are read from public data, nothing is imported. If the DSH shortcut
  service gains an `invoke()`, swap `dispatchCommand()` for it.
- **Desktop keyboard bridge.** In the Desktop app,
  `installKeyboard(..., native = true)` hands configurable commands to the
  native accelerator bridge instead of the DOM, so command re-dispatch only
  works in the Web runtime (the target here). Consequences: Help → Keyboard
  Shortcuts falls back to the local panel on Desktop, File → Open Settings uses
  the DOM launcher instead, and Edit → Find Sessions would be a no-op on
  Desktop. Web is unaffected.
- **`settings.launcher` DOM dependency.** `File → Open Settings` prefers the
  product's labelled launcher button and falls back to `settings.open`; if the
  seat is renamed the fallback still opens settings on Web, and the row disables
  itself when neither path exists.
- **Left sidebar collapsed state** is read from the frame's
  `[data-sidebar-collapsed]` DOM attribute. If a future frame build renames it,
  `Collapse Both Sidebars` falls back to "assume expanded" and could invert on
  an already-collapsed sidebar; everything else is unaffected.
- **Popup is absolute inside the header** (per the build brief: no portal). The
  current `.header`/`.headerLeading` do not clip overflow; a future `overflow`
  rule there would clip the dropdown.
- **Popup stacking**: `z-index: 70` within the header's leading cell. Dialogs
  sit above it (intended); a menu never outranks the product's modal layer.
- **Header width cost**: the wide strip is ~250px of the header's leading grid
  column. The title column is `minmax(0, 1fr)`, so narrow headers shrink the
  title; at <900px the `⋯` collapse removes the cost entirely.
- **macOS desktop titlebar**: the header is a drag region; the strip declares
  `-webkit-app-region: no-drag`, so tabs stay clickable. Web GUI unaffected.
- **No locale service**: English copy is inline per the brief; the fallback
  shortcut panel also shows the catalog's localized labels/keys where present.
- **Right sidebar without a session**: there is genuinely no surface for the
  service to act on, so the row is disabled rather than falsely "working".
- **Verification**: besides `node --check` (exit 0), the bundle was exercised
  three times with a temporary jsdom + React 18 harness (registration, roles and
  ARIA, open/close on click/outside/Escape, ArrowUp/Down/Home/End/Enter/Left/
  Right, focus restore, command re-dispatch, settings-launcher fallback, local
  shortcut panel on Desktop runtime, disabled rows, About boot data, and the
  <900px compact layout). The harness was a throwaway file and is not part of
  the package.
- **Not done here**: installation into a profile and visual sign-off — the Lead
  owns those. Nothing needs to be wired up manually beyond installing the
  bundle; the patch row id is `harness-chrome`.

## 6. File sizes

| File | Lines |
|---|---|
| `client.js` | 1195 |
| `README.md` | 84 |
| `NOTES.md` | 191 (this file) |
| `index.js` | 9 |
| `cordis.patch.yml` | 3 |
| `package.json` | 26 |
