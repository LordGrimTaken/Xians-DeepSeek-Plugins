# Inventory

Every non-core plugin installed in the maintainer's `web` profile, plus the ones
that are installed but deliberately **not** part of this pack. The list was taken
from the profile's `package.json` (`$DSH_HOME/profiles/web/package.json`), not
from memory.

- **15 included** — the curated set in this repository.
- **3 excluded** — installed on the machine, left out of the pack for the reasons
  below.
- **Core bundles** — the `@deepseek-ai/*` packages ship with DeepSeek Harness
  itself. They are not plugins in the sense this pack uses the word and are not
  listed individually beyond this note.

## Included

| # | Plugin | Package | Version | Kind | Why it is in |
|---|---|---|---|---|---|
| 1 | context-lens | `@goodandready/dsh-context-lens` | `0.1.35` | npm | Keeps code and build output semantic instead of dumping bodies and megabytes into context. |
| 2 | notify | `@goodandready/dsh-plugin-notify` | `0.4.7` | npm | Answers "did the turn finish?" across parallel sessions and closed tabs. |
| 3 | git-worktree | `@laoyuehanni/dsh-git-worktree` | `0.4.13` | npm | Branch visibility and real worktree isolation for parallel agents on one repository. |
| 4 | repo-map | `@mkaliezz/dsh-repo-map` | `0.2.2` | npm | One cheap call to see a repository's shape before reading files. |
| 5 | agent-team-plus | `@local/agent-team-plus` | `0.6.6` | vendored | Turns Agent Teams into roles with enforced tools, write scopes, budgets, and handoffs. |
| 6 | browser-control | `@local/browser-control` | `0.1.0` | vendored | Verifies the Web UI by loading the real page in headless Chromium. |
| 7 | game-lab | `@local/game-lab` | `1.4.5` | vendored | In-app Android emulator: the build/install/play loop without leaving Harness. |
| 8 | harness-chrome | `@local/harness-chrome` | `1.0.0` | vendored | Keyboard-first File/Edit/View/Window/Help menu in the conversation header. |
| 9 | harness-deck | `@local/harness-deck` | `1.0.0` | vendored | A right workspace deck that reports real session, plan, job, and trajectory state. |
| 10 | harness-rail | `@local/harness-rail` | `1.0.0` | vendored | Left-rail Search/Sessions/Customize/Activity pages and a live status strip. |
| 11 | inhouse-browser | `@local/inhouse-browser` | `0.1.0` | vendored | Reads docs and references inside the app, with tabs, bookmarks, and history. |
| 12 | mobile-host | `dsh-mobile-host` | `0.3.13` | vendored | Pairs the DSH Mobile Android app and drives sessions from a phone. |
| 13 | run-hidden | `@local/dsh-plugin-run-hidden` | `1.0.0` | vendored | GUI smoke tests that provably never put a window on the user's screen. |
| 14 | session-resume | `@local/session-resume` | `0.1.0` | vendored | A host crash no longer silently kills a running turn. |
| 15 | system-monitor | `@local/system-monitor` | `1.0.0` | vendored | CPU, memory, and host RSS in the sidebar, so a slow turn has an obvious suspect. |

"Kind" matches the source recorded in [`index.json`](../index.json): **npm** is a
published package; **vendored** is a package whose full source is included under
[`plugins/`](../plugins) in this repository. The maintainer's installed copies
match these versions: the four npm packages come from the registry, and the
eleven in-repo packages are linked from their development directories.

## Excluded

| Plugin | Package | Version | Kind | Why it is not in the pack |
|---|---|---|---|---|
| Zenith Ops Tools | `@local/zenith-ops-tools` | `1.0.0` | vendored | Personal tooling for the maintainer's own Discord bot sessions. Its own manifest describes it as "opt-in Harness tools used to maintain the Zenith Family Discord bot" — no general use for other Harness users. |
| DSH Android | `@zseven-w/dsh-android` | `0.1.0-rc.12` | npm | Third-party plugin, superseded here by Game Lab. It targets DSH 0.1.5-rc.1 and a `>=24.11` Node engine; Game Lab covers the Android device loop from inside the app on the current host line, so shipping both would duplicate the purpose. |
| Hadal Mint theme | `@local/harness-hadal-theme` | `1.0.0` | vendored | A theme, not a functional plugin, and it is **not mounted** in the active profile: it is absent from the profile's `dsh.profile.bundles` and from its plugin rows. It is the source of the icon family's palette, not part of the installed everyday set. |

## Core bundles

The profile also carries the shipped `@deepseek-ai/*` bundles — `dsh-base`,
`dsh-web-app`, and the experimental bundles for Agent Teams, the plugin market,
inspector, Ralph, session search, session titles, terminal, worktrees, voice
input, and the badge skill. They arrive with DeepSeek Harness, are maintained
upstream, and are not redistributed by this pack. `license` and version
information for them belongs to the DeepSeek Harness project.

## Duplicates and stale copies

The maintainer's plugin directories contain timestamped `.bak-*` copies left by
earlier iterations of `agent-team-plus`. They are not installed and are not
vendorable: the pack contains exactly one copy of each package under
`plugins/`, at the version listed above. `scripts/validate.mjs` asserts the 15
slugs and the vendored package manifests, so a stale duplicate cannot silently
enter the pack.
