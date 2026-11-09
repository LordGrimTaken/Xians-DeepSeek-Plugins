# @local/session-resume

Host-side crash recovery for the DSH Harness: after the host process crashes or
restarts, sessions whose turn was interrupted are re-driven automatically with a
continuation prompt.

## Why

The harness runs every session inside one Node process (`dsh web`). If that
process dies — a JS crash, an OOM kill, `systemctl restart dsh-mobile`, a host
reboot — any in-flight turn dies with it. The session log then ends inside an
open turn. Nothing used to resume it: the user had to open the session and type
"continue" themselves.

This plugin closes that gap without moving sessions out of the host process.

## What it does

1. Listens to `session/event` and mirrors every session's turn boundary into
   `<DSH_HOME>/cache/session-resume/state.json` (`turn/start` opens an entry,
   `turn/end` clears it).
2. On a fresh host boot (detected by host pid change) waits `delaySeconds`, then
   for every ledger candidate:
   - drops entries older than `maxAgeMinutes`,
   - skips subagent sessions and sessions already live in this process,
   - re-reads the durable session log through `sessionPersistence` and only
     proceeds when the final turn is genuinely open,
   - sends a continuation prompt through `sessionController.prompt` — the same
     path the phone/browser client uses. The agent-loop resume path appends the
     synthetic interrupted tool results and `turn/end` first, so the model sees a
     balanced transcript.
3. Writes every decision to `<DSH_HOME>/logs/session-resume.log`.

## Safety rails

| Rail | Meaning |
| --- | --- |
| `dryRun` | log candidates, never prompt |
| `maxResumesPerBoot` | hard cap on sessions re-driven per boot |
| `maxAgeMinutes` | never revive a turn older than this |
| `circuitBreakerMaxBoots` / `circuitBreakerWindowMinutes` | if the host restarted too often, skip recovery (prevents boot loops) |
| `maxAttemptsPerSession` / `attemptWindowMinutes` | stop auto-resuming one session repeatedly |
| live-session check | never touches a session already attached in this process |
| `skipSubagentSessions` | subagent sessions are owned by their parent |

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `dryRun` | `false` | detection only |
| `delaySeconds` | `10` | settle time after boot |
| `maxAgeMinutes` | `120` | ignore older interruptions |
| `scanDurableSessions` | `true` | durable-log fallback scan at boot |
| `scanWindowMinutes` | `20` | only logs changed this recently are scanned |
| `maxScanSessions` | `12` | cap on durable-scan candidates |
| `maxResumesPerBoot` | `10` | cap per boot |
| `staggerMs` | `1500` | delay between consecutive resumes |
| `circuitBreakerWindowMinutes` | `15` | window for boot counting |
| `circuitBreakerMaxBoots` | `4` | boots in window before giving up |
| `maxAttemptsPerSession` | `2` | per-session retry cap |
| `attemptWindowMinutes` | `30` | attempt window |
| `skipSubagentSessions` | `true` | skip subagent sessions |
| `continuationText` | see index.js | prompt text, `{time}` is replaced |
| `stateFile` / `logFile` | derived from `DSH_HOME` | overrides |

## Operations

- Ledger: `/var/lib/dsh/dsh-home/cache/session-resume/state.json`
- Log: `/var/lib/dsh/dsh-home/logs/session-resume.log`
- Live config is the `session-resume` row in the web profile; edit it through the
  plugin manager/settings UI, never by hand-editing `cordis.patch.yml`.
- Disable quickly: plugin manager → set `session-resume` enabled = false.

## Tests

```
node --test test/
```

`test/unit.test.mjs` drives the plugin through a fake Cordis context and covers:
fresh boot resume, balanced log skip, dry run, live-session skip, stale entries,
subagent skip, attempt cap and circuit breaker.
