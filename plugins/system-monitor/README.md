# System Monitor (`@local/system-monitor`)

Live CPU and memory readout for the DeepSeek Harness desktop UI, shown in the sidebar footer beside the shipped
footer controls.

## Behaviour

- Host route `GET /system-monitor` (browser-authenticated, `ctx.connection.requestRejection`) returns a JSON sample:
  - `cpu.percent` — CPU utilisation since the previous poll (delta of `os.cpus()` times; `null` on the first read),
    plus `cores`, `model`, `loadavg`.
  - `memory.usedBytes / totalBytes / usedPercent`, and the Harness host process's own `processRssBytes`.
  - `uptimeSeconds`, `platform`, `release`, `sampledAt`.
- **Composer dock pill** (`conversation.composer.dock`, order 2): compact `CPU 12% · RAM 46%` pill in the row under
  the composer that already shows `turns/steps · tok/s` and `token total · cache hit`; visible while a conversation is
  open, click refreshes, tooltip carries cores/used-total GiB/app RSS/uptime. Shaped like the core StatsPills
  (same padding, gap, tabular numerals, gauge icon).
- **Sidebar footer** (`sidebar.footer.action`, order 10): persistent readout beside Settings — both figures when the
  sidebar is wide, CPU % in the collapsed 56 px rail. Coloured LED dot (green < 75 %, amber ≥ 75 %, red ≥ 90 %).
- Both placements poll every 3 s (15 s while the page is hidden), refresh on click, and catch up on
  `visibilitychange`. No persistence; the route reads only local OS counters.


## Files

| File | Purpose |
|---|---|
| `index.js` | Host plugin: registers the authenticated route. |
| `metrics.js` | Pure sampling helpers (`sampleSystem`, `sampleMemory`, CPU delta window). |
| `client.js` | Browser module: composer-dock pill + sidebar footer widget, sharing one polling hook. |
| `cordis.patch.yml` | Inserts the `system-monitor` row. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title/description. |
| `icon.svg` | Original gauge artwork. |
| `test/metrics.test.mjs` | `node --test` checks for the sampling contract. |

## Verify

```powershell
node --check index.js; node --check metrics.js; node --check client.js
node --test test/metrics.test.mjs
```

After installation the Host row mounts on the next application restart (the same restart that activates other host
plugins). Once live, `GET /system-monitor` from the app page returns the sample; the dock pill and the sidebar footer
readout appear and update every few seconds.

**Client-only edits** (this file, `client.js`) need only a **page reload** in the app window — no app restart.

## Install / remove

```
plugin_manager install_bundle  target: C:\Users\Austin\dsh-plugins\system-monitor
plugin_manager remove_bundle   target: @local/system-monitor
```

Not a git repository: local plugin directory, no push.
