# Plugins

One card per plugin, in the same order as the catalog in the
[README](../README.md). Every entry lists the package, the exact pinned version,
where the code comes from, the requirements, and only configuration keys that
exist in the package itself.

Versions are the ones in [`index.json`](../index.json). `Source: npm` means the
package is published and pulled from the registry; `Source: in-repo` means it is
vendored under [`plugins/`](../plugins) and served from this repository.

## How the configuration examples work

- The script and the manual instructions install every plugin as a loader row
  with id `xdp-<slug>`. Rows are created with `disabled: true`; the examples
  below show the row after you have enabled it.
- Row config goes in your profile's `cordis.patch.yml` — on a default setup,
  `~/.dsh/profiles/web/cordis.patch.yml` — or you can edit the same values in the
  plugin's card under **Settings → Plugins**.
- A row override **replaces** the whole config object for that row, so include
  every key you want to keep. Keys you omit fall back to the plugin's defaults.
- A plugin marked "no configuration" has no row config keys at all; its
  behaviour is fixed or tuned in its source, which the card says where relevant.

| # | Plugin | Version | Source | Category |
|---|---|---|---|---|
| 1 | [context-lens](#context-lens) | `0.1.35` | npm | Context |
| 2 | [notify](#notify) | `0.4.7` | npm | Reliability |
| 3 | [git-worktree](#git-worktree) | `0.4.13` | npm | Git |
| 4 | [repo-map](#repo-map) | `0.2.2` | npm | Context |
| 5 | [agent-team-plus](#agent-team-plus) | `0.6.6` | in-repo | Agent teams |
| 6 | [browser-control](#browser-control) | `0.1.0` | in-repo | Verification |
| 7 | [game-lab](#game-lab) | `1.4.5` | in-repo | Android |
| 8 | [harness-chrome](#harness-chrome) | `1.0.0` | in-repo | Web UI |
| 9 | [harness-deck](#harness-deck) | `1.0.0` | in-repo | Web UI |
| 10 | [harness-rail](#harness-rail) | `1.0.0` | in-repo | Web UI |
| 11 | [inhouse-browser](#inhouse-browser) | `0.1.0` | in-repo | Web UI |
| 12 | [mobile-host](#mobile-host) | `0.3.13` | in-repo | Mobile |
| 13 | [run-hidden](#run-hidden) | `1.0.0` | in-repo | Workflow |
| 14 | [session-resume](#session-resume) | `0.1.0` | in-repo | Reliability |
| 15 | [system-monitor](#system-monitor) | `1.0.0` | in-repo | Web UI |

---

## context-lens

<img src="../icons/context-lens.svg" width="40" height="40" alt="context-lens icon">

**Context** · *Semantic AST code skeletonization and build/test log compression.*

**What it does.** Adds two agent tools. `context_lens_code` returns an AST
skeleton — imports, classes, structs, interfaces, exported types, signatures, and
doc comments, with function bodies dropped — for TypeScript, JavaScript, Python,
Go, C/C++, Rust, Java, and SQL DDL. `context_lens_log` condenses test and build
output from Jest, Vitest, Pytest, `node --test`, Go test, Cargo, Webpack, Vite,
TSC, Maven, and Gradle: failures, assertion diffs, and stack traces survive,
passing runs collapse to a summary. Path focus keeps the files you are editing
whole while the rest of the workspace stays skeletal.

**Why you'd want it.** Reading a large repository otherwise spends context on
bodies you are not changing. This plugin complements the core's token budgeting
and tool-result pruning: the core manages how much context exists, context-lens
manages how much meaning fits in it.

- **Package:** `@goodandready/dsh-context-lens` · **Version:** `0.1.35` · **Source:** npm
- **Author:** GooDAnDReaDY · **License:** MIT · **Upstream:** [GooDAnDReaDY/dsh-context-lens](https://github.com/GooDAnDReaDY/dsh-context-lens)

**Requirements.** DSH 0.2.x (the package peers on `@deepseek-ai/cordis` 4.x and
the 0.2 settings/tools lines) and Node.js 20+. The client half adds a settings
card, so reload the page after enabling.

**Configuration.** Three keys, edited in the plugin card or as row config:

```yaml
- id: xdp-context-lens
  name: '@goodandready/dsh-context-lens'
  disabled: false
  config:
    compressionMode: balanced    # raw | balanced | aggressive
    astSkeletonMaxDepth: 3       # skeleton depth cap
    autoCompressThreshold: 4000  # chars before auto:true compresses; 0 disables
```

`auto: true` on `context_lens_log` only fires on recognised test/build output, so
normal command output is left for the core pruner.

---

## notify

<img src="../icons/notify.svg" width="40" height="40" alt="notify icon">

**Reliability** · *Sounds, toasts, desktop and web push, IM webhooks on turn end, errors, and approval waits.*

**What it does.** The host watcher turns three events — `task_done`, `error`, and
`approval_requested` — into five optional channels: synthesized Web Audio
chimes; cross-session toasts with a **Go to session** button; HTML5 desktop
notifications; outbound JSON webhooks for Feishu, WeCom, DingTalk, Slack,
Discord, or a custom endpoint; and W3C Web Push through a service worker, which
reaches a phone even with every Harness tab closed. Webhook URLs live in **DSH
Credentials** and the config stores only the credential name. Optional do-not-
disturb window, session-prefix exclusions, and a "background sessions only"
filter keep it quiet while you are watching.

**Why you'd want it.** With several parallel sessions, "did it finish?" is the
question you ask most. This answers it without switching tabs, and it survives a
closed browser via web push.

- **Package:** `@goodandready/dsh-plugin-notify` · **Version:** `0.4.7` · **Source:** npm
- **Author:** GooDAnDReaDY · **License:** MIT · **Upstream:** [GooDAnDReaDY/dsh-plugin-notify](https://github.com/GooDAnDReaDY/dsh-plugin-notify)

**Requirements.** DSH 0.2.x web profile. Web push needs a secure context (HTTPS
or localhost); on iOS the PWA must be added to the Home Screen (iOS 16.4+). The
plugin has host and client halves, so restart the profile after installing.

**Configuration.** The common keys; the complete table is in the upstream README.

```yaml
- id: xdp-notify
  name: '@goodandready/dsh-plugin-notify'
  disabled: false
  config:
    enableSound: false
    enableToasts: false
    enableDesktopNotifications: false
    notifyBackgroundOnly: false
    notifySubagents: false
    webhooks:
      feishu: NOTIFY_FEISHU_WEBHOOK      # credential name, not the URL
      wecom: NOTIFY_WECOM_WEBHOOK
      dingtalk: NOTIFY_DINGTALK_WEBHOOK
      slack: NOTIFY_SLACK_WEBHOOK
      discord: NOTIFY_DISCORD_WEBHOOK
      custom: NOTIFY_CUSTOM_WEBHOOK
    events: [task_done, error, approval_requested]
    timeoutMs: 5000
    dnd:
      start: ''                          # HH:MM; equal/empty disables DND
      end: ''
    webPush:
      enabled: false
      onlyWhenAway: true                 # skip push while a tab is connected
```

Add each webhook URL under **Settings → Credentials**, then type its credential
name in the plugin card. For web push: enable the channel, press **Enable push on
this device**, accept the browser prompt, then **Test push**.

---

## git-worktree

<img src="../icons/git-worktree.svg" width="40" height="40" alt="git-worktree icon">

**Git** · *Branch visibility, a commit graph, and isolated git worktrees for Web UI sessions.*

**What it does.** Puts the current branch in the composer tool row. The branch
popup expands in place into an IDEA-style picker (local and remote groups,
folder hierarchy, search, divergence marks) plus a real commit graph with
author, date, message, and file summary. Row menus cover checkout, create,
rename, delete, copy, push (with a force-push lease), fast-forward-only update,
and fetch-and-prune, with a floating progress card for long operations. Flip the
**Worktree** toggle and a session gets an isolated worktree under
`<repo>/.dsh/gitworktree/<branch>/`, registered as a real workspace; the plugin's
page in **Settings → Plugins** lists and removes them.

**Why you'd want it.** Parallel agents on one repository stop fighting over the
checkout, and you can see the branch a session is on before it surprises you.
Removal keeps the branch and archives the workspace's sessions.

- **Package:** `@laoyuehanni/dsh-git-worktree` · **Version:** `0.4.13` · **Source:** npm
- **Author:** LaoYueHanNi · **License:** MIT · **Upstream:** [LaoYueHanNi/dsh-git-worktree](https://github.com/LaoYueHanNi/dsh-git-worktree)

**Requirements.** The `web` profile (`dsh web`) and a DSH 0.2.0-rc.1 or later
host; the package declares Node.js `>=22.19`. Install from npm — the upstream
repo no longer carries prebuilt output, so `github:` installs are over. If you
are upgrading from a legacy `github:` install (≤ 0.3.2, old package name
`dsh-git-worktree`), remove the old name first, then add the new one; worktree
folders and settings carry over.

**Configuration.** No row config keys are required. Manage worktrees from the
branch menu or the plugin's page in **Settings → Plugins**. Update and remove
with the normal profile commands:

```bash
dsh plugin --profile web update --latest @laoyuehanni/dsh-git-worktree
dsh plugin --profile web remove @laoyuehanni/dsh-git-worktree
```

Removing the plugin leaves worktree folders in place.

---

## repo-map

<img src="../icons/repo-map.svg" width="40" height="40" alt="repo-map icon">

**Context** · *A read-only repository structure and symbol map.*

**What it does.** Registers a `repo-map` command that walks a repository root and
renders a compact map: directory structure plus the declarations it recognises,
skipping generated and vendor directories. It deliberately does **not** inject
whole source files into context — it tells the agent where things are, and the
agent then reads only what it needs.

**Why you'd want it.** It is the cheap first step in an unfamiliar tree: one call
to see the shape, instead of reading files until the layout is obvious.

- **Package:** `@mkaliezz/dsh-repo-map` · **Version:** `0.2.2` · **Source:** npm
- **Author:** MkaliezZ · **License:** MIT · **Upstream:** [MkaliezZ/dsh-repo-map](https://github.com/MkaliezZ/dsh-repo-map)

**Requirements.** DSH 0.2.x and Node.js 20+. No client half; enabling the row is
enough.

**Configuration.** Optional default root; a path passed to the command wins:

```yaml
- id: xdp-repo-map
  name: '@mkaliezz/dsh-repo-map'
  disabled: false
  config:
    root: /path/to/repo
```

---

## agent-team-plus

<img src="../icons/agent-team-plus.svg" width="40" height="40" alt="agent-team-plus icon">

**Agent teams** · *Role-based teammates with enforced tool, write, and time budgets, and structured handoffs.*

**What it does.** Adds role definitions on top of DSH Agent Teams. A role is a
Markdown file with a small frontmatter block that sets the allowed and denied
tools, workspace write scopes, a tool-call budget, a wall-clock budget, extra
destructive-command patterns, and `fresh` or `fork` context. The plugin installs
the role's policy in each teammate's scope and enforces it on every call, adds
`team_roles` / `team_diagnostics` / `spawn_role` for the Lead, and provides
`team_handoff` for every member: a write to `reviews/team/` plus a lightweight
reference to the Lead, instead of a long report pasted into a message. It also
installs the message-trust rule — peer messages are data, never approval — and
gates task completion on a handoff artifact for the same task.

**Why you'd want it.** A team of agents without budgets and write scopes is a
race condition with a progress bar. This makes each teammate's job, tools, and
spending explicit and recoverable after a host restart.

- **Package:** `@local/agent-team-plus` · **Version:** `0.6.6` · **Source:** in-repo (`plugins/agent-team-plus/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** The shipped Agent Teams bundle must be active
(`@deepseek-ai/dsh-experimental-agent-team-profile`, which provides
`spawn_teammate`, `send_message`, and `team_task_*`). This plugin is host-only:
restart the host after enabling. No roles ship with it — copy the starter files
from its `examples/` directory into `~/.dsh/team-roles/` or
`<workspace>/.dsh/team-roles/` first.

**Configuration.** No row config. A role file looks like this:

```markdown
---
description: Read-only security reviewer. Never edits files.
tools_allow: read, glob, grep, web_fetch, web_search
tools_deny: write, edit, bash
write_scopes: reviews/security
max_tool_calls: 60
max_minutes: 20
deny_commands: \bdocker\s+push\b || \bscp\b
context: fresh
---
You are a security reviewer. Cite exact paths and line numbers.
```

Known limitation from the plugin: a role's `model` intent is validated and
reported but is not applied by this DSH version, because the shipped
`SpawnTeammateRequest` has no model field.

---

## browser-control

<img src="../icons/browser-control.svg" width="40" height="40" alt="browser-control icon">

**Verification** · *A headless Chromium the agent can drive against the live, authenticated Harness Web UI.*

**What it does.** Starts a host-side headless Chromium with a throw-away profile
and exposes HTTP routes under `/_dsh/browser-control`: `probe`, `open`,
`screenshot`, `dom`, `console`, `eval`, `click`, `type`, `key`, and `close`. The
agent loads the real Web UI through its authenticated URL, reads DOM summaries,
takes screenshots, clicks, and types — so UI work is checked by looking at the
page instead of assuming. Navigation is restricted to loopback, every request
must come from a loopback peer, and POSTs need a same-origin `Origin` header. The
browser never opens a visible window, never touches your browser profile, and
closes itself after 15 idle minutes.

**Why you'd want it.** It turns "the plugin should render" into a screenshot and
a text assertion from the real app. It is the tool that verifies the rest of this
pack's pages.

- **Package:** `@local/browser-control` · **Version:** `0.1.0` · **Source:** in-repo (`plugins/browser-control/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** Host-only: restart the host after enabling. A Chromium-based
browser must be findable — resolution order is the `DSH_BROWSER_CHROME` path,
installed Google Chrome, Microsoft Edge, then a Playwright headless shell. Loopback
only; it is a diagnostic tool, not a proxy (use `web_fetch` for remote pages).

**Configuration.** No row config. To choose the browser, set the environment
variable before launching DSH:

```bash
export DSH_BROWSER_CHROME=/usr/bin/google-chrome  # absolute path, your install
```

Drive it over HTTP (use your own DSH port):

```bash
curl -s -X POST http://127.0.0.1:8080/_dsh/browser-control/open \
  -H 'Origin: http://127.0.0.1:8080' -H 'Content-Type: application/json' -d '{}'
curl -s http://127.0.0.1:8080/_dsh/browser-control/screenshot
curl -s -X POST http://127.0.0.1:8080/_dsh/browser-control/close \
  -H 'Origin: http://127.0.0.1:8080' -H 'Content-Type: application/json' -d '{}'
```

---

## game-lab

<img src="../icons/game-lab.svg" width="40" height="40" alt="game-lab icon">

**Android** · *An Android emulator page inside the app: live screen, touch controls, install-and-play and build-and-play.*

**What it does.** Boots one lean headless AVD on demand and streams it into a
Harness page with an H.264/WebCodecs live view (automatic PNG fallback), a
Smooth/Compat toggle, focus mode, and real input: tap, drag/swipe, Back/Home/
Recents, rotation, hardware keys, a keyboard dock, and an on-screen pad. A game
library scans your folders for APKs and Gradle/Capacitor projects, groups builds
by name, **Play** installs and launches, and **Build & play** detects the project
type and runs the right pipeline before installing the newest APK. Streams stop
when nobody is watching and the emulator stops after five idle minutes.

**Why you'd want it.** It closes the loop "change the game, build it, see it on a
device" without a second emulator window and without leaving the conversation.
It drives the Android SDK emulator already on the machine; it never downloads
another emulator or a system image.

- **Package:** `@local/game-lab` · **Version:** `1.4.5` · **Source:** in-repo, a mirror of the public repo
- **Author:** Xianwuli (LordGrimTaken) · **License:** MIT · **Upstream:** [LordGrimTaken/dsh-inapp-plugin](https://github.com/LordGrimTaken/dsh-inapp-plugin)

**Requirements.** The Android SDK (`ANDROID_HOME` or `ANDROID_SDK_ROOT`) with an
installed x86_64 system image, plus a JDK and Node/npm for Build & play. Windows
and Linux are tested; macOS is not. Expect roughly 3.5 GB of host RAM while the
emulator runs. Linux without `/dev/kvm` falls back to software emulation
(`-accel off` + SwiftShader) — much slower; a lean AOSP image is the lever. The
plugin has a host half, so restart the host after enabling; the page reload loads
the client half.

**Configuration.** Verified keys from the upstream configuration doc:

```yaml
- id: xdp-game-lab
  name: '@local/game-lab'
  disabled: false
  config:
    avdName: gamelab
    gameRoots:
      - /path/to/your/games
    idleMinutes: 5       # stop after this many idle minutes (1-120)
    ramMb: 2048          # guest RAM (1024-6144)
    cores: 2             # vCPU (1-8); forced to 1 on Linux
    width: 720
    height: 1280
    density: 320
    gpuMode: host        # host | swiftshader_indirect | auto
    maxFps: 8            # PNG loop pacing (2-20)
    bootTimeoutMs: 240000
```

The bundle defaults to an empty `gameRoots` and falls back to `$HOME/Games`, plus
`/srv/dsh/workspaces` on the maintainer's cloud host.
`width`/`height` are the main lever on software emulation.

---

## harness-chrome

<img src="../icons/harness-chrome.svg" width="40" height="40" alt="harness-chrome icon">

**Web UI** · *Lamprey-style File/Edit/View/Window/Help menu tabs in the conversation header.*

**What it does.** Puts a compact 26 px command strip into the conversation
header's leading seat: **File** (New Session, Open Plugins, Open Settings),
**Edit** (Find Sessions, Copy Selection, Select Composer Draft), **View** (Toggle
Left Sidebar, Toggle Right Sidebar, Reload Page), **Window** (Toggle Fullscreen,
Collapse Both Sidebars), and **Help** (Keyboard Shortcuts, About DeepSeek
Harness). Every row is wired to a public client surface; a row whose surface is
unavailable right now is disabled with the reason in its tooltip instead of
disappearing. Full keyboard navigation, ARIA menu semantics, and a `⋯` collapse
below ~900 px of header width.

**Why you'd want it.** It makes the Web UI keyboard-first: sessions, sidebars,
fullscreen, and settings are one menu away without hunting for icons.

- **Package:** `@local/harness-chrome` · **Version:** `1.0.0` · **Source:** in-repo (`plugins/harness-chrome/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** The Web UI and a page reload. Client-only: no host restart and
no config. The host half is an empty stub.

**Configuration.** None.

---

## harness-deck

<img src="../icons/harness-deck.svg" width="40" height="40" alt="harness-deck icon">

**Web UI** · *A Lamprey-style right workspace deck with six session-aware guide cards.*

**What it does.** Adds six page types to the right sidebar, ordered among the
shipped cards: **Side chat** (branches the conversation with the public
`forkSession` service), **Artifacts** (live workspace path plus a Files deep
link), **Review** (an honest turn-review page that explains where reviews open),
**Plan** (live plan-mode state and the agent's todo checklist), **Background
tasks** (live job roster with progress and a two-press stop), and **Reasoning
trace** (trajectory stage counts and request rows, with a switch to the
Trajectory view). On first boot it also opens the right column and nudges its
width toward the reference layout.

**Why you'd want it.** The right sidebar becomes a real workspace panel: what is
running, what changed, what the plan is — all read from public services rather
than mocked values.

- **Package:** `@local/harness-deck` · **Version:** `1.0.0` · **Source:** in-repo (`plugins/harness-deck/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** The Web UI and a page reload. It requires only the shipped
`slots`, `sidebarRightTabs`, and `sidebarRight` services; optional services
(`uiWorkspace`, `jobs`, `ui-trajectory`, `remote.commands`, plan/todo
projections) degrade to a graceful page state when absent. Client-only.

**Configuration.** None.

---

## harness-rail

<img src="../icons/harness-rail.svg" width="40" height="40" alt="harness-rail icon">

**Web UI** · *Lamprey-style left rail pages and a bottom status strip.*

**What it does.** Adds four global main panels behind rail icons — **Search**
(type-ahead over the session catalog), **Sessions** (all non-archived sessions
grouped Today / Yesterday / Earlier, with a New session action), **Customize**
(cards that open Settings › General, the Plugin Manager, Settings › Models, and
Settings), and **Activity** (the background-job roster). It also adds a 24 px
`shell.bottom` status strip: project name, model chip, in/out token counters,
running/ready/idle dot, and `ctx` / `cache` meters with percentages. Values come
from public client services; where a surface exposes no public API, the plugin
uses a documented, labelled DOM fallback.

**Why you'd want it.** Session search, a real session list, and ambient token and
context pressure, always one click away.

- **Package:** `@local/harness-rail` · **Version:** `1.0.0` · **Source:** in-repo (`plugins/harness-rail/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** The Web UI and a page reload. Client-only; the host half is a
stub.

**Configuration.** None.

---

## inhouse-browser

<img src="../icons/inhouse-browser.svg" width="40" height="40" alt="inhouse-browser icon">

**Web UI** · *A tabbed in-app web browser with bookmarks, history, and a start page.*

**What it does.** Adds a browser page (and a sidebar globe icon) inside the Web
UI: up to 10 tabs, each with its own back/forward stack persisted across reloads;
an address bar that opens URLs directly, adds `https://` to bare hosts, and
searches SearXNG at `https://searx.be` for anything else; bookmarks; local
history (80 entries); a start page with quick links; and **Open externally** to
hand the current URL to your system browser. State lives in `localStorage` under
`dsh.inhouse-browser.v1` — nothing is sent to the host.

**Why you'd want it.** Read the docs, issue, or reference page without leaving
the app and losing your session.

- **Package:** `@local/inhouse-browser` · **Version:** `0.1.0` · **Source:** in-repo (`plugins/inhouse-browser/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** The Web UI and a page reload. Pages render in an `<iframe>`:
sites that send `X-Frame-Options: DENY` or a `frame-ancestors` CSP — GitHub, MDN,
Hacker News, Bing, DuckDuckGo, and others — refuse to be framed and show blank,
with an Open in system browser hint after 4.5 s. Wikipedia, Internet Archive,
DeepSeek, SearXNG, and example.com do embed.

**Configuration.** No profile config. Tuning constants live at the top of the
plugin's `client.js`: `SEARCH_URL`, `QUICK_LINKS`, `MAX_TABS`, `MAX_HISTORY`,
`MAX_BOOKMARKS`, `MAX_STACK`, `EMBED_TIMEOUT_MS`. Keyboard: `Ctrl/Cmd+L` focuses
the address bar, `Ctrl/Cmd+T` opens a tab, `Ctrl/Cmd+W` closes the active tab,
`Enter` navigates, `Escape` reverts the bar.

---

## mobile-host

<img src="../icons/mobile-host.svg" width="40" height="40" alt="mobile-host icon">

**Mobile** · *A loopback HTTP + SSE API that lets the DSH Mobile Android app pair with this host and drive sessions.*

**What it does.** Starts a loopback-only server on `127.0.0.1:3543` implementing
DSH Android API v1. The phone pairs with a one-time 6-digit code (QR, manual
entry, Tailscale one-tap, or a single-use recovery code), then gets its **own**
bearer token: list and read sessions, send prompts and attachments, interrupt a
turn, follow live events over SSE, manage goals, mirror approvals and questions,
browse workspace files read-only, search messages, fork sessions, and receive
ntfy push notifications. It never exposes the Harness web server, launch token,
session-log paths, or a shell/file-write surface.

**Why you'd want it.** Kick off a turn, answer an approval, or read a transcript
from the phone without keeping the desktop page open. Subagent/teammate sessions
are hidden from the phone by default.

- **Package:** `dsh-mobile-host` · **Version:** `0.3.13` · **Source:** in-repo, part of the public DSH Mobile repo
- **Author:** Xian (LordGrimTaken) · **License:** MIT · **Upstream:** [LordGrimTaken/dsh-mobile](https://github.com/LordGrimTaken/dsh-mobile) (`host-plugin/`)

**Requirements.** A DSH 0.2.x host with port `3543` free, and the DSH Mobile
Android app. The phone reaches the host over loopback or, for a real device,
through Tailscale Serve terminating TLS in front of `127.0.0.1:3543`. Host-only:
restart the host after enabling. Pairing state is persisted, so devices survive
restarts.

**Configuration.** The row config; every key has a working default.

```yaml
- id: xdp-mobile-host
  name: 'dsh-mobile-host'
  disabled: false
  config:
    port: 3543
    host: 127.0.0.1             # loopback only, enforced
    publicBaseUrl: ''           # e.g. https://pc.tailnet.ts.net, for the QR payload
    pairing:
      codeTtlMs: 300000         # pairing code lifetime, 5 min
      maxDevices: 32
    sessions:
      hideInternal: true        # hide subagent/teammate sessions
    approvals:
      mobileAnswer: true        # allow the phone to answer approvals
```

Pair from the host with the built-in page, or mint a code over loopback:

```bash
# Open http://127.0.0.1:3543/pair in a browser on the host, or:
curl -s -X POST http://127.0.0.1:3543/mobile/v1/pair/new
```

The pairing page renders a QR and the six-digit fallback; codes are one-time and
expire in five minutes. There is no config key for the Tailscale setup itself —
that is a `tailscale serve` configuration outside DSH.

---

## run-hidden

<img src="../icons/run-hidden.svg" width="40" height="40" alt="run-hidden icon">

**Workflow** · *Run a windowed program on an invisible Windows desktop so checks never open a window on your screen.*

**What it does.** Adds one tool, `run_hidden`. It creates a separate Windows
desktop, starts the program there with `CreateProcessW` and
`STARTUPINFO.lpDesktop` (through `hidden-run.ps1`), lets it run for `seconds`,
counts any visible windows the process put on the real desktop, and kills the
process tree.

```text
run_hidden({ exe, args?, cwd?, seconds? })
  -> { ok, survived, realDesktopWindows, pid, desktop, seconds, exitCode?, error? }
```

`exe` is an absolute path, `args` is one entry per argument, and `seconds`
defaults to 6 (range 1–120). Exit codes: `0` hidden and healthy, `1` launch
failed, `2` died early, `3` leaked a window onto the real desktop.

**Why you'd want it.** Smoke-testing a launcher or installer otherwise flashes
windows on the user's screen. This proves the program starts and stays up while
the desktop stays clean.

- **Package:** `@local/dsh-plugin-run-hidden` · **Version:** `1.0.0` · **Source:** in-repo (`plugins/run-hidden/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** Windows with PowerShell — the tool is Windows-only. A hidden
desktop is not composited by DWM, so it **cannot** be screenshotted; for visual
verification use a headless renderer or the app's own headless mode. Windows 11
Store stubs (`notepad`, `calc`, `mspaint`) relaunch themselves on the interactive
desktop; smoke-test real Win32 hosts or the app you actually care about.

**Configuration.** None; the tool parameters are the whole interface.

---

## session-resume

<img src="../icons/session-resume.svg" width="40" height="40" alt="session-resume icon">

**Reliability** · *Resumes sessions whose turn was interrupted by a host crash or restart.*

**What it does.** Mirrors every session's turn boundary to a small ledger under
`<DSH_HOME>/cache/session-resume/state.json` (`turn/start` opens an entry,
`turn/end` clears it). On a fresh host boot — detected by the host pid changing —
it waits `delaySeconds`, drops stale entries, skips subagent and already-live
sessions, re-reads the durable session log, and only continues a turn that is
genuinely open: it sends the continuation prompt through
`sessionController.prompt`, the same path a phone or browser client uses. Every
decision is written to `<DSH_HOME>/logs/session-resume.log`.

**Why you'd want it.** A crash, an OOM kill, or a reboot mid-turn no longer
leaves a dead session waiting for you to type "continue". Safety rails —
per-boot cap, per-session attempt cap, age limit, circuit breaker, dry-run — stop
it from boot-looping.

- **Package:** `@local/session-resume` · **Version:** `0.1.0` · **Source:** in-repo (`plugins/session-resume/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** Host-only: restart the host after enabling. Do not hand-edit
the live row — the plugin's README asks you to change settings through the plugin
manager/settings UI; edit the profile row only to change its shipped defaults.

**Configuration.** These are the values the vendored bundle ships with; the
plugin's README documents the safety rails, `continuationText` (`{time}` is
substituted), and the `stateFile` / `logFile` overrides.

```yaml
- id: xdp-session-resume
  name: '@local/session-resume'
  disabled: false
  config:
    enabled: true
    dryRun: false
    delaySeconds: 10
    maxAgeMinutes: 120
    scanDurableSessions: true
    scanWindowMinutes: 120
    maxScanSessions: 20
    maxResumesPerBoot: 10
    staggerMs: 1500
    circuitBreakerWindowMinutes: 15
    circuitBreakerMaxBoots: 4
    maxAttemptsPerSession: 2
    attemptWindowMinutes: 30
    skipSubagentSessions: true
```

---

## system-monitor

<img src="../icons/system-monitor.svg" width="40" height="40" alt="system-monitor icon">

**Web UI** · *A live CPU and memory readout in the sidebar footer.*

**What it does.** Adds an authenticated host route, `GET /system-monitor`, that
returns a live sample: CPU percent since the previous poll (plus cores, model,
load average), memory used/total/percent, the Harness host process's own RSS,
uptime, platform, and release. The client renders a compact `CPU 12% · RAM 46%`
pill in the composer dock row, and a persistent readout beside Settings in the
sidebar footer (CPU percent only in the collapsed 56 px rail) with a status LED:
green under 75%, amber at or above 75%, red at or above 90%. Both placements poll
every 3 s — 15 s while the page is hidden — refresh on click, and catch up on
`visibilitychange`.

**Why you'd want it.** Before blaming the model for a slow turn, check whether
the host is pegged. It also shows the app's own RSS, which is the useful number
when the emulator or a build is running.

- **Package:** `@local/system-monitor` · **Version:** `1.0.0` · **Source:** in-repo (`plugins/system-monitor/`)
- **Author:** Xian · **License:** see [CREDITS](CREDITS.md) · **Upstream:** maintained in this repository

**Requirements.** The Web UI. The host route mounts on the next host restart; the
widget is a client module, so reload the page for UI changes. It injects
`@deepseek-ai/dsh-client-ui-sidebar`.

**Configuration.** None.
