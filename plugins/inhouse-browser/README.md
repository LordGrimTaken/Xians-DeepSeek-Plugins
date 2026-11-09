# In-house Browser (`@local/inhouse-browser`)

A tabbed browser page that lives inside the Harness Web UI. It is a local,
in-house plugin: a `main`-slot page plus a sidebar globe icon, written as
plain-JS React with no build step.

![icon](./icon.svg)

## What it does

- **Tabs** — up to 10, each with its own back/forward stack, persisted across reloads.
- **Address bar** — URLs open directly; bare hosts get `https://`; anything else
  becomes a web search (default endpoint: `https://searx.be`, chosen because it
  permits being embedded).
- **Bookmarks** — star the current page; chips sit under the toolbar.
- **History** — recent pages in a popover, capped at 80 entries, local only.
- **Start page** — quick links plus recently visited pages.
- **Open externally** — hands the current URL to your system browser.

State lives in `localStorage` under `dsh.inhouse-browser.v1`; nothing is sent
to the Host.

## Embedding caveat

Pages render in an `<iframe>`. Sites that send `X-Frame-Options: DENY` or a
`Content-Security-Policy: frame-ancestors` directive (GitHub, MDN, Hacker News,
Bing, DuckDuckGo, …) refuse to be framed and show up blank. When a frame does
not finish loading within 4.5 s, the page shows a hint with an
**Open in system browser** action. Wikipedia, Internet Archive, DeepSeek,
SearXNG, Marginalia, and example.com do allow embedding.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + L` | Focus the address bar |
| `Ctrl/Cmd + T` | New tab |
| `Ctrl/Cmd + W` | Close the active tab |
| `Enter` | Navigate to the typed address |
| `Escape` | Revert the address bar and blur |

## Files

| File | Purpose |
| --- | --- |
| `package.json` | Bundle manifest: `dsh.bundle.patch` + `dsh.client` (`platform: web`, `immediately: true`). |
| `cordis.patch.yml` | Inserts the `inhouse-browser` row. |
| `index.js` | Host half; the page is Client-only, so this is a no-op `apply`. |
| `client.js` | The whole page: URL handling, persistence, React views, slot registrations. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager display title/description. |
| `icon.svg` | Original globe artwork used by the plugin inventory and sidebar. |

## Registrations

| Slot | Registration |
| --- | --- |
| `main` (keyed) | `{ key: 'inhouse-browser' }` → the browser page |
| `sidebar.panellist` (list) | `{ id: 'inhouse-browser', order: 20, label: () => … }` → the sidebar globe |

Both are created inside `ctx.slots.inject(...)`, so they collapse and reinstall
with the slot declaration.

## Tuning

- Search provider: `SEARCH_URL` at the top of `client.js`.
- Start-page tiles: `QUICK_LINKS`.
- Limits: `MAX_TABS`, `MAX_HISTORY`, `MAX_BOOKMARKS`, `MAX_STACK`, `EMBED_TIMEOUT_MS`.

## Install / update / remove

The bundle is already installed in the `desktop` profile (the profile links
this directory, so edits here are what the app loads).

```text
# reinstall after structural changes (new files, manifest changes)
plugin_manager install_bundle  target: <absolute path to this directory>

# remove
plugin_manager remove_bundle   target: @local/inhouse-browser
```

After editing `client.js`, refresh the Harness page to load the new module
generation.

## Verification done

- `node --check` on `client.js` and `index.js`.
- Manifest and locale JSON parse.
- Live Client slots report `main#inhouse-browser` and `sidebar.panellist#inhouse-browser` active.
- `normalizeUrl` / `hostOf` exercised against 12 address forms (URLs, ports,
  IPv4/IPv6 localhost, blocked schemes, search fallback) — all pass.
- Visual review in the running page was not available in this session; see the
  caveat above before treating appearance as verified.
