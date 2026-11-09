# Credits

This pack exists because other people published their work and made it usable.
Versions are pinned in [`index.json`](../index.json); the source of truth for
each plugin's documentation is its upstream repository.

## Maintainer

**Xian (LordGrimTaken)** — [github.com/LordGrimTaken](https://github.com/LordGrimTaken)

Curates the set, maintains the in-repo plugins, designs the green icon family,
and keeps the market index and installer working. The repository is MIT-licensed
(see [LICENSE](../LICENSE)).

## Published plugins

These packages are installed from npm, not redistributed here. Their MIT
licenses and copyright notices live in each package's own `LICENSE` file and
remain in force.

| Author | Package | Upstream | License |
|---|---|---|---|
| GooDAnDReaDY | `@goodandready/dsh-context-lens` | [GooDAnDReaDY/dsh-context-lens](https://github.com/GooDAnDReaDY/dsh-context-lens) | MIT |
| GooDAnDReaDY | `@goodandready/dsh-plugin-notify` | [GooDAnDReaDY/dsh-plugin-notify](https://github.com/GooDAnDReaDY/dsh-plugin-notify) | MIT |
| LaoYueHanNi | `@laoyuehanni/dsh-git-worktree` | [LaoYueHanNi/dsh-git-worktree](https://github.com/LaoYueHanNi/dsh-git-worktree) | MIT |
| MkaliezZ | `@mkaliezz/dsh-repo-map` | [MkaliezZ/dsh-repo-map](https://github.com/MkaliezZ/dsh-repo-map) | MIT |

GooDAnDReaDY's READMEs ask for a GitHub star and a GitHub issue for bugs — the
upstream repositories are the right place for both.

## Vendored packages

The 11 in-repo packages are copied into [`plugins/`](../plugins) at a pinned
version so the market index and the installer serve exactly the code in this
repository. Nine are maintained here by Xian; the two mirrors keep their
original author and license.

| Package | Directory | Upstream | License |
|---|---|---|---|
| `@local/game-lab` | [`plugins/game-lab/`](../plugins/game-lab) | [LordGrimTaken/dsh-inapp-plugin](https://github.com/LordGrimTaken/dsh-inapp-plugin) | MIT © 2026 Xianwuli (LordGrimTaken) |
| `dsh-mobile-host` | [`plugins/mobile-host/`](../plugins/mobile-host) | [LordGrimTaken/dsh-mobile](https://github.com/LordGrimTaken/dsh-mobile) (`host-plugin/`) | MIT © 2026 Xianwuli (LordGrimTaken) |
| `@local/agent-team-plus` | [`plugins/agent-team-plus/`](../plugins/agent-team-plus) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/browser-control` | [`plugins/browser-control/`](../plugins/browser-control) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/harness-chrome` | [`plugins/harness-chrome/`](../plugins/harness-chrome) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/harness-deck` | [`plugins/harness-deck/`](../plugins/harness-deck) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/harness-rail` | [`plugins/harness-rail/`](../plugins/harness-rail) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/inhouse-browser` | [`plugins/inhouse-browser/`](../plugins/inhouse-browser) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/dsh-plugin-run-hidden` | [`plugins/run-hidden/`](../plugins/run-hidden) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/session-resume` | [`plugins/session-resume/`](../plugins/session-resume) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |
| `@local/system-monitor` | [`plugins/system-monitor/`](../plugins/system-monitor) | maintained in this repository | MIT (see [LICENSE](../LICENSE)) |

`game-lab` and `mobile-host` are mirrors: report bugs and read the deep-dive
docs in their public repositories, not here. The other nine are developed for
this pack — issues about them belong in this repository.

## Icons and brand

The 15 icons, the icon sheet, and the banner were drawn for this repository
under the **Hadal Mint** palette: an abyssal ink container (`#0a1f17`), mint
glyph (`#4ee59b`), and an ice highlight (`#a8ffd9`). The rules — 64×64 viewBox,
rounded-square container, glyph strokes 3.2–3.8 px with round caps, no text, no
external references, under 4 KB — are in [brand/palette.md](../brand/palette.md).
Hadal Mint is an in-house theme; the theme itself is not part of this pack (see
[INVENTORY](INVENTORY.md)).

## Built on

DeepSeek Harness — [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
Every plugin here is written against its Cordis plugin system and the shipped
`@deepseek-ai/*` bundles. Those bundles stay upstream and are not redistributed
by this pack.
