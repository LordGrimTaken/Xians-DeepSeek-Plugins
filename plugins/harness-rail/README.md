# @local/harness-rail

Lamprey-style **left rail pages + bottom status strip** for the DeepSeek Harness
Web UI, shipped as a client-only DSH bundle. The host half is an empty stub; the
whole surface is plain-JS React registered through the Web UI slot renderer.

## What it adds

Four global main panels, each with a 16–20 px `currentColor` icon row in the left
rail (orders 30/40/50/60 so they append after the shipped panel rows):

| Rail row | Main panel key | What it shows |
|---|---|---|
| Search | `hr-search` | Type-ahead filter over the session catalog (title, project path, id); Enter opens the first match. |
| Sessions | `hr-sessions` | Every non-archived session grouped **Today / Yesterday / Earlier**, with relative times and a New session action. |
| Customize | `hr-customize` | Cards that open real surfaces: Appearance → Settings › General, Plugins → Plugin Manager, Models → Settings › Models, Skills & settings → Settings. |
| Activity | `hr-activity` | Background-job roster for the current conversation (live progress, output size, stop control). |

One root-scope **`shell.bottom` status strip** (24 px):

- left: `❯ dsh · <project>` (mint prompt glyph, workspace/project name)
- middle: recorded model chip, `[in …] [out …]` token counters, `running`/`ready`/`idle` state dot
- right: `ctx` and `cache` meters with percentages

All values are read from the public Client services and the framework standard
kit; nothing is a hardcoded mock. Values that a surface cannot expose through a
public API are reached through a documented, labelled DOM fallback instead (see
`NOTES.md`).

## Package layout

```
package.json       bundle manifest; client half loads immediately on platform "web"
index.js           host stub (no host services, no teardown)
client.js          everything: components, CSS, slot registrations
cordis.patch.yml   inserts the `harness-rail` row
README.md          this file
NOTES.md           exact slot/service APIs, real vs. fallback data, gaps
```

## Installation (Lead / profile owner)

```yaml
# cordis.patch.yml shipped with the bundle
- insert:
    - id: harness-rail
      name: '@local/harness-rail'
```

Register the bundle directory as a local plugin in the profile like
`@local/inhouse-browser`; nothing else to wire. Do **not** copy the files into the
DSH checkout or the theme package.

## Verification

- `node --check client.js` → passes (node 24).
- `node --check index.js` → passes.
- Components were rendered through React 18.3.1 `renderToString` with real
  shape-faithful fixtures: 4 main panels, 4 rail icons (both sizes/active states),
  the status strip, empty states, and a composition without the jobs service.
- Style tag is created inside `ctx.effect` with `data-plugin` /
  `data-plugin-css`, and both registrations and the tag dispose on unload.
