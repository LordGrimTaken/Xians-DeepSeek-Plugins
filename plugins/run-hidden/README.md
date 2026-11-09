# Run Hidden — a DSH plugin

Adds one tool, **`run_hidden`**, to every session in the profile: it starts a windowed program on an invisible
Windows desktop, confirms it stayed alive, and stops it. Nothing appears on the user's screen.

## Why

Automated checks (launching a game launcher, an Electron client, an installer) otherwise pop windows onto the
interactive desktop. Running them on a separate desktop keeps the screen clean while still proving the program
starts and stays up.

## Tool

```
run_hidden({ exe, args?, cwd?, seconds? })
  → { ok, survived, realDesktopWindows, pid, desktop, seconds, exitCode?, error? }
```

- `exe` — absolute path of the executable.
- `args` — one entry per argument.
- `cwd` — working directory.
- `seconds` — how long to let it run before it is stopped (1–120, default 6).

`realDesktopWindows` counts visible windows owned by that process on the real desktop. A successful run reports
`0`. Exit codes: `0` hidden and healthy, `1` launch failed, `2` died early, `3` leaked a window.

## Mechanism

`hidden-run.ps1` calls `CreateDesktop`, then `CreateProcessW` with `STARTUPINFO.lpDesktop` set to that desktop, waits,
counts the process's visible windows on the real desktop, and kills the process tree.

## Limits

- Windows only. Other platforms should use headless rendering or the app's own headless switch.
- A hidden desktop is not composited by DWM, so it cannot be screenshotted. For visual verification use a headless
  renderer (Playwright) or the app's headless mode driven over its DevTools protocol.
- Windows 11 Store stubs (`notepad`, `calc`, `mspaint`) relaunch themselves on the interactive desktop; smoke-test
  real Win32 hosts (`charmap`, `winver`) or the app you actually care about.

## Install

```powershell
plugin_manager({ action: "install_bundle", target: "C:\\dev\\dsh-workspace\\dsh-plugins\\run-hidden" })
```
