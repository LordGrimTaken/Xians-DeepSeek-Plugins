# Install

Three ways to install the same 15 plugins into a Harness profile. Pick the one
that fits how you manage your profile. Methods B and C also add the 15 loader
rows with `disabled: true`, so nothing starts until you enable it; method A
installs the entries through the plugin manager.

- [Prerequisites](#prerequisites)
- [Method A — market index](#method-a--market-index)
- [Method B — one-shot script](#method-b--one-shot-script)
- [Method C — manual, per plugin](#method-c--manual-per-plugin)
- [Enable, disable, reload](#enable-disable-reload)
- [Update](#update)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Verification checklist](#verification-checklist)

## Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| DeepSeek Harness 0.2.x | `dsh --version` | The pack is pinned against the 0.2 line. |
| Node.js 22+ | `node -v` | `git-worktree` declares `>=22.19`; `mobile-host` declares `>=22`. |
| pnpm | `pnpm -v` | `dsh plugin ... add` forwards its arguments to pnpm in the profile directory. |
| git | `git --version` | For cloning this repo and for `git-worktree`. |
| A `web` profile | `dsh web` | The examples use `--profile web`, the default Web UI profile. |

Optional, per plugin:

| Plugin | Extra requirement |
|---|---|
| `browser-control` | A Chromium-based browser: Google Chrome, Microsoft Edge, or a Playwright headless shell. Override the path with `DSH_BROWSER_CHROME`. |
| `game-lab` | Android SDK (`ANDROID_HOME` or `ANDROID_SDK_ROOT`) with an installed x86_64 system image; a JDK and Node/npm for Build & play. Windows and Linux are tested, macOS is not. |
| `mobile-host` | The DSH Mobile Android app, and Tailscale Serve (or another TLS terminator) when pairing a real phone rather than localhost. Port `3543` must be free. |
| `notify` | Web push needs a secure context (HTTPS or localhost); on iOS, add the PWA to the Home Screen (iOS 16.4+). |
| `run-hidden` | Windows with PowerShell. The tool does nothing on other platforms. |

## Method A — market index

1. Open the Harness Web UI.
2. Go to **Settings → Plugins → Discover**.
3. Add this index URL:

   ```text
   https://raw.githubusercontent.com/LordGrimTaken/Xians-DeepSeek-Plugins/main/index.json
   ```

4. Install the entries you want from the list.

The index is a DSH plugin-market format-1 index. Published plugins resolve to
their npm package; the vendored ones resolve to `plugins/<slug>` in this
repository at the commit recorded in the index, so you get the exact same code
as a clone. Market entries install as normal DSH bundles — if one becomes active
and you don't want it yet, toggle it off in **Settings → Plugins**.

## Method B — one-shot script

```bash
git clone https://github.com/LordGrimTaken/Xians-DeepSeek-Plugins.git
cd Xians-DeepSeek-Plugins
./scripts/install.sh --profile web
```

The script installs all 15 packages (npm ones by pinned version, in-repo ones as
`link:` paths to `plugins/<slug>`) and appends the 15 `xdp-<slug>` loader rows,
each with `disabled: true`, to your profile's `cordis.patch.yml` (at
`~/.dsh/profiles/web/cordis.patch.yml` unless `$DSH_HOME` says otherwise). It is
idempotent: rows that already exist are left alone.

| Flag | Meaning |
|---|---|
| `--profile <name>` | Profile to install into. Default: `web`. |
| `--only <list>` | Comma-separated slugs; install only those. |
| `--dry-run` | Print the commands the script would run, change nothing. |
| `--list` | Print the 15 slugs and exit. |
| `-h`, `--help` | Print the script's own usage. |

Examples:

```bash
./scripts/install.sh --profile web --list
./scripts/install.sh --profile web --dry-run
./scripts/install.sh --profile web --only notify,system-monitor
```

The script needs `dsh` on `PATH`; set `DSH_BIN=/path/to/dsh` to use another
binary. It re-runs safely: a package already recorded in the profile and a row
id already present are left alone.

## Method C — manual, per plugin

Install the package into the profile. Published plugins use their npm name:

```bash
dsh plugin --profile web add @goodandready/dsh-context-lens
dsh plugin --profile web add @goodandready/dsh-plugin-notify
dsh plugin --profile web add @laoyuehanni/dsh-git-worktree
dsh plugin --profile web add @mkaliezz/dsh-repo-map
```

In-repo plugins are linked from the clone. Use the **absolute** path to the
package directory:

```bash
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/agent-team-plus
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/browser-control
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/game-lab
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/harness-chrome
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/harness-deck
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/harness-rail
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/inhouse-browser
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/mobile-host
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/run-hidden
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/session-resume
dsh plugin --profile web add link:/path/to/Xians-DeepSeek-Plugins/plugins/system-monitor
```

Then add the matching rows to your profile's `cordis.patch.yml` — copy them from
the repo's [`cordis.patch.yml`](../cordis.patch.yml). Each row has id
`xdp-<slug>` and `disabled: true`:

```yaml
# Context
- insert:
    - id: xdp-context-lens
      name: '@goodandready/dsh-context-lens'
      disabled: true
    - id: xdp-repo-map
      name: '@mkaliezz/dsh-repo-map'
      disabled: true
```

The row id is what **Settings → Plugins** and the profile use to address the
plugin; the `name` must match the installed package exactly.

## Enable, disable, reload

1. Open **Settings → Plugins**. The rows you installed are listed; rows added by
   method B or C start off.
2. Toggle the rows you want on.
3. Reload the page so the client half loads.
4. Restart the host for host-side plugins: `mobile-host`, `session-resume`,
   `system-monitor`, `browser-control`, `agent-team-plus`, `run-hidden`, and
   `game-lab`.

Disabling is the reverse: toggle the row off and reload. No files are deleted;
each plugin's own state (notification subscriptions, worktrees, pairing records,
Game Lab AVD) stays where it was.

## Update

Published plugins are installed at exact versions, so update with `--latest`
(which ignores the pinned range) or by adding the new version explicitly:

```bash
dsh plugin --profile web update --latest @goodandready/dsh-context-lens
dsh plugin --profile web update --latest @goodandready/dsh-plugin-notify
dsh plugin --profile web update --latest @laoyuehanni/dsh-git-worktree
dsh plugin --profile web update --latest @mkaliezz/dsh-repo-map

# or pin the version yourself
dsh plugin --profile web add @mkaliezz/dsh-repo-map@0.2.2
```

In-repo plugins update by pulling the repo and re-running the installer, which
refreshes the `link:` targets and re-pins the rows:

```bash
cd /path/to/Xians-DeepSeek-Plugins
git pull
./scripts/install.sh --profile web
```

If you installed through the market index, update the same way as any other
market entry: install the newer index entry for that plugin.

## Uninstall

Order matters: remove the row before removing the package, otherwise the profile
points at a package that no longer resolves.

1. Disable the plugin in **Settings → Plugins** and reload.
2. Delete its `xdp-<slug>` row from `~/.dsh/profiles/web/cordis.patch.yml`.
3. Remove the package:

   ```bash
   dsh plugin --profile web remove @goodandready/dsh-context-lens
   dsh plugin --profile web remove @local/harness-deck
   ```

4. Restart the host if the plugin was host-side.

To remove the whole pack, repeat for all 15 rows, or restore a profile backup
from before the install.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A plugin is missing from **Settings → Plugins** | The package is not installed in the profile you are running | Check `--profile`: the examples use `web`. Re-run the add command for that profile, or re-run `./scripts/install.sh --profile <name>`. |
| A row exists but nothing happens after toggling | A client plugin needs a page reload; a host-side plugin needs a host restart | Reload the page. For `mobile-host`, `session-resume`, `system-monitor`, `browser-control`, `agent-team-plus`, `run-hidden`, and `game-lab`, restart the host. |
| Plugin loads but is inert | The row is disabled, or the package resolved to a stale copy | Toggle the row on. For `link:` installs, confirm the absolute path still exists and points at a directory with `package.json`. |
| Icon is missing or still the upstream artwork | The client bundle is cached, or you installed an npm plugin whose own icon ships with the package | Hard-reload the page. Optionally run `./scripts/apply-icon-overlay.sh` to copy this pack's icons over the installed npm packages (`--restore` undoes it; a package update reverts it, so re-run after updates). |
| `dsh plugin add link:...` fails | A relative path, a typo, or the profile was never initialized | Use the absolute path to `plugins/<slug>`. The first `dsh plugin --profile <name>` command initializes the profile. |
| Index has no entries | The URL was mistyped, or the file is not reachable | Paste the exact index URL. The index is served from the `main` branch as raw JSON; no authentication is needed. |
| `mobile-host` row loads but nothing listens | Port `3543` is taken, or the row failed validation | Free the port; the plugin logs the error and stays loaded without a server instead of throwing. Bind addresses are loopback-only by design. |
| `game-lab` never boots | No Android SDK or no x86_64 system image, or no KVM | Install an SDK and an x86_64 image; check `ANDROID_HOME`. On Linux without `/dev/kvm` expect software emulation to be much slower. |
| `browser-control` cannot find a browser | No Chrome/Edge/Playwright shell in the expected locations | Install one, or set `DSH_BROWSER_CHROME` to an absolute browser path before launching DSH. |
| `run-hidden` tool is missing | You are not on Windows | The plugin is Windows-only; on other platforms use a headless renderer or the app's headless switch. |
| Web push never arrives | Not a secure context, or the device was never subscribed | Use HTTPS or `localhost`, enable the channel in the plugin card, then **Enable push on this device**. |

## Verification checklist

- [ ] `dsh --version` reports a 0.2.x version.
- [ ] `node -v` reports v22 or newer, and `pnpm -v` and `git --version` work.
- [ ] In a clone: `node scripts/validate.mjs` passes (validates the index, icons,
      vendored packages, and the 15 slugs).
- [ ] `./scripts/install.sh --list` prints the 15 slugs.
- [ ] After method B or C, **Settings → Plugins** lists the plugin rows and none
      is active yet.
- [ ] After method B or C, the profile's `cordis.patch.yml` contains 15 `xdp-`
      rows:

  ```bash
  grep -c 'id: xdp-' ~/.dsh/profiles/web/cordis.patch.yml
  ```

- [ ] One client plugin (for example `system-monitor`) shows its UI after toggling
      and reloading the page.
- [ ] One host plugin (for example `session-resume`) is listed as active after a
      host restart.
- [ ] A second run of `./scripts/install.sh --profile web` creates no duplicate
      rows.
