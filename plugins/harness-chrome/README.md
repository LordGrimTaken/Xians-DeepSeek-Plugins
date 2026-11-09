# @local/harness-chrome — Lamprey-style header command tabs

Client-only DeepSeek Harness bundle that puts a compact menu bar into the
conversation header's **leading seat** (`conversation.header.leading`, root
scope), ahead of the session title:

```
File   Edit   View   Window   Help
```

Both states use it — with a Session and without one — and every row is a real
action wired to public client surfaces (`ctx.layout`, `ctx.sidebarRight`,
`ctx.uiWorkspace`, `ctx.pluginNavigation`, the `ctx.shortcuts` command catalog,
and plain DOM/navigator APIs).

## What it does

| Menu | Rows |
|---|---|
| File | New Session · Open Plugins · Open Settings |
| Edit | Find Sessions · Copy Selection · Select Composer Draft |
| View | Toggle Left Sidebar · Toggle Right Sidebar · Reload Page |
| Window | Toggle Fullscreen · Collapse Both Sidebars |
| Help | Keyboard Shortcuts · About DeepSeek Harness |

Rows that no public surface can satisfy right now are disabled with a reason in
their tooltip instead of disappearing (e.g. "Toggle Right Sidebar" without an
on-screen Session). `NOTES.md` carries the full action matrix and the exact
APIs used.

## Behaviour

- Click a tab to open it, click it again (or click outside) to close; Escape
  closes and returns focus to the tab.
- Keyboard: ArrowDown/ArrowUp move rows, Home/End jump, Enter/Space activate,
  ArrowLeft/ArrowRight walk across the five menus, Tab closes.
- ARIA: `menubar` / `menu` / `menuitem` / `separator`, `aria-haspopup="menu"`,
  `aria-expanded`, `aria-disabled` rows, roving tabindex.
- Below ~900px of header width the five tabs collapse into one `⋯` menu with
  File/Edit/View/Window/Help sections, so the strip never pushes the title row.
- Strip is 26px tall, 11.5px monospace, and sits inside the header's existing
  30px title row; the dropdown is an absolutely positioned child, so it adds no
  layout.
- Help → Keyboard Shortcuts opens the product's own shortcut reference when its
  `shortcuts.open` command is bound (Web); in the Desktop app, or when that
  command is unavailable, a small local panel lists the most useful catalog
  shortcuts.
- File → Open Settings clicks the product's own labelled settings launcher
  (falling back to the `settings.open` command), so it opens the same overlay
  from the same trigger the sidebar uses.

## Files

```
package.json        bundle metadata (`dsh.bundle` + `dsh.client`, platform web)
index.js            host half; no services, no teardown
client.js           the whole feature (plain browser JS, require('react') only)
cordis.patch.yml    inserts one row: id `harness-chrome`
README.md           this file
NOTES.md            slots/services, action matrix, gaps, risks
```

## Install

Normal DSH bundle install; the Lead owns installation. The patch inserts:

```yaml
- insert:
    - id: harness-chrome
      name: '@local/harness-chrome'
```

No profile files, no locale files, and no other packages are modified.

## Development checks

```sh
node --check client.js
```

The client half is a single `window.__ModuleLoader__.load({ id, factory })`
script: no imports/JSX/npm dependencies, styling is one module-owned `<style>`
tag with `data-plugin="@local/harness-chrome"`, and the slot registration plus
the style tag are both owned by `ctx.effect` cleanups for HMR unload.
