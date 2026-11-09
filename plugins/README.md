# plugins/ — vendored plugin packages

These eleven plugin packages ship in the repository so users can install them
without the npm registry and without the original machine-specific checkouts.
The four published npm plugins in the curated set are **not** vendored: the
market index installs them from the registry, at the exact versions it lists.

Every vendored `package.json` keeps the package's own `name` and `version`,
declares a top-level `"icon": "./icon.svg"`, and ships that icon inside the
package. Package ids that begin with `@local/` are local-only by design.

| Slug | Package | What it does |
| --- | --- | --- |
| `agent-team-plus` | `@local/agent-team-plus` | Role-based teammates, per-teammate tool and write budgets, and structured handoffs. |
| `browser-control` | `@local/browser-control` | Headless Chromium control for the live DSH Web UI: screenshots, DOM, clicks, typing, JS. |
| `game-lab` | `@local/game-lab` | In-app Android emulator page with H.264 live view, Capacitor build-and-play and touch input. |
| `harness-chrome` | `@local/harness-chrome` | Lamprey-style header command menu tabs for the Harness Web UI. |
| `harness-deck` | `@local/harness-deck` | Lamprey-style right workspace deck for the Harness Web UI. |
| `harness-rail` | `@local/harness-rail` | Lamprey-style left rail pages plus the bottom status strip. |
| `inhouse-browser` | `@local/inhouse-browser` | In-house tabbed web browser page inside the Harness Web UI. |
| `mobile-host` | `dsh-mobile-host` | Loopback HTTP API that pairs the DSH Mobile Android app with the host. |
| `run-hidden` | `@local/dsh-plugin-run-hidden` | Runs windowed programs on an invisible Windows desktop so no window appears. |
| `session-resume` | `@local/session-resume` | Resumes sessions whose turn was interrupted by a host crash or restart. |
| `system-monitor` | `@local/system-monitor` | Live CPU and memory readout in the sidebar footer. |

Layout and rules:

- One directory per package, copied from its source checkout without `.git`,
  `node_modules`, backups, logs, or build caches.
- `cordis.patch.yml` next to each `package.json` is the bundle patch the package
  itself declares; it is what the package contributes when selected.
- Everything in the curated set is installed **off**: `cordis.patch.yml` at the
  repository root and `scripts/install.sh` add the rows with
  `disabled: true`, and users switch on what they want in Settings → Plugins.
- The green icons in `icons/` are the market cards' artwork; the `icon.svg`
  inside each package is the per-package copy.
