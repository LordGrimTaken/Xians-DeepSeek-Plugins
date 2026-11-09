# Verification log

Date: **2026-11-05**. This page records what was actually observed while
building Game Lab, including the measurements and the things that were not
verified. It is deliberately specific so future changes have a baseline.

## Environment

| item | value |
|---|---|
| Host | Windows 11, Intel i7-11800H (8C/16T), 15.8 GB RAM, NVIDIA RTX 3050 Ti + Intel UHD |
| Acceleration | AEHD 2.2 (`emulator -accel-check`: installed and usable); Hyper-V absent |
| Android SDK | emulator 37.2.13, platform-tools adb, build-tools 36.0.0 |
| System image | `system-images;android-34;google_apis;x86_64` |
| AVD | `gamelab`, 720x1280 @ 320 dpi, 2 GB RAM request, 2 vCPU, data partition 2 GB |
| DSH | Desktop 0.2.2-rc.1, Web UI, desktop profile |
| JDK / Node | JDK 21.0.13, Node 24.21 |

## Automated tests

```text
node --test test/frame.test.mjs test/fence.test.mjs test/video.test.mjs \
          test/integration.test.mjs host/library.test.mjs
```

Result on this machine: **32 tests, 29 pass, 3 skipped, 0 fail** (~0.5 s).
The skipped tests are the optional real-APK/aapt2 checks; they require
`GAME_LAB_TEST_APK` / `GAME_LAB_TEST_RELEASES` and an Android SDK.

Coverage:

- PNG splitter (chunk walking, arbitrary chunk boundaries, garbage resync) and
  multipart congestion handling;
- route fence (loopback, Origin, cross-site, cross-origin, LAN peer);
- H.264 NAL statistics (SPS/PPS/VCL counting across split chunks, reset);
- config clamping, status shape, portable APK scan/grouping, build-output
  project linking, Gradle vs Capacitor build-plan detection;
- routes `/status`, `/games`, `/heartbeat`, `/stream.h264` (offline 409) on a
  real loopback HTTP server.

## Emulator lifecycle

| measurement | value |
|---|---|
| start -> `adb devices` shows the device | 24-32 s |
| start -> `getprop sys.boot_completed` = 1 | **36-62 s** (cold boots; 61 s after a heavy build) |
| stop via `adb emu kill` -> state `off` | < 10 s, no qemu process left |
| AVD persistence | installed APKs present after stop/start and reboot |
| display | `screen_off_timeout=2147483647`, `mStayOn=true`, `mWakefulness=Awake` |
| idle auto-stop | 5 minutes after the last heartbeat/input: log `idle timeout` -> `stopped (idle)`; host free RAM returned from ~1.7 GB to ~6 GB |

## Live view

### PNG compatibility path

- ~0.7-1.6 fps at 720x1280; `screencap -p` costs ~1.0-1.2 s per frame.
- A `frame.png` response of a game screen was 70-212 KB depending on content.
- Tap round trip (HTTP -> `input tap` -> 200) ~0.7 s.

### H.264 smooth path

- Direct `screenrecord --output-format=h264 --bit-rate 6000000 --time-limit 6 -`
  capture during continuous scrolling: **701,805 bytes, 114 frames / 6 s
  (~19 fps)**.
- Game Lab's `GET /stream.h264` during scrolling: 122,766 bytes captured
  (22 frames after trimming the final partial NAL), decoded cleanly by ffmpeg
  (`ffprobe` counted 22 frames; `ffmpeg -v error` reported no errors).
- Static screens: 1-2 frames over 6-8 s; `screenrecord`/MediaCodec only emits
  frames when the display content changes. A running card game's static board
  therefore updates only when something moves.
- `/status.video` reported `sps:true, pps:true`, `frames` growing, and
  `fps` up to ~19 during motion; bitrate ~0.1-1.0 Mbps.
- One viewer at a time; a second request returns 409 `video_busy`, and a new
  stream restarts the encoder so SPS/PPS + IDR are always first.
- `/status.avds` returned `["gamelab"]` on this machine after the v1.2 reload
  (host build `2026-11-05.10`), so the offline AVD picker has data to show.

## Install / launch / build

| measurement | value |
|---|---|
| install + launch a 9.6 MB card game APK | 3.7 s |
| install + launch a 6.0 MB landscape city-builder APK | 14.0 s |
| landscape game | status/frame resolution followed to 1280x720 |
| input | a tap sent through `/input` advanced the game's guided onboarding to "Turn 1 - your move" |
| Build & Play, plain Gradle project, emulator off | 66.6 s total (boot + `assembleDebug` 2 s up-to-date + install/launch) |
| Build & Play, Capacitor project (`npm run android:apk`) | **71.4 s** total: detected `kind:"capacitor"`, one `project` step, `BUILD SUCCESSFUL in 37 s`, APK installed and launched (`com.*` foreground) |

The Capacitor case is the important one: running only Gradle had installed an
APK with stale web assets; the plan now rebuilds and syncs the web bundle first.

## UI / client

- Client registration was confirmed live in the connected page:
  `main#game-lab` and `sidebar.panellist#game-lab` (order 25) active.
- A stub-loader test evaluates `client.js`, calls `factory`/`apply` and checks
  both slot registrations, with no runtime error at load time.
- The page renders offline/online/booting/error states in a render smoke test
  with mocked React (no DOM).

## Browser-control follow-up (2026-11-05)

A local `@local/browser-control` plugin was written for this machine: a
headless Edge/Chrome driven over the DevTools protocol, pointed at the
authenticated local DSH URL from `ctx.connection`, with routes for screenshot,
DOM, eval, click, type, key and console capture. It was used to load the real
Game Lab page at 1600x1000 (light and dark theme) and produced these findings:

- **Fixed a blank-page crash.** The page rendered in a new client and the
  `main` slot crashed with
  `ReferenceError: Cannot access 'effectiveResolution' before initialization`.
  `effectiveResolution` was used by the orientation line before its `const`
  declaration; fixed by moving the declaration above it. The page now renders
  in a fresh client.
- **Fixed two Smooth-view decoder defects**, both invisible to the host/ffmpeg
  checks:
  - the codec string used the SPS NAL header (`0x67`) as the profile byte, so
    it configured `avc1.6742c0` instead of `avc1.42c029`;
  - an `avc1` WebCodecs decoder was configured without a
    `description` (AVCDecoderConfigurationRecord) and fed Annex-B chunks where
    it expects AVCC length-prefixed samples.
  A standalone WebCodecs check with the corrected record and AVCC sample
  decoded a 720x1280 keyframe (`frames:1`, `nonBlack:1`) in Edge; the client
  implements the same path. The client decode was later verified end-to-end on
  the live page: `canvas` 720x1280 with `nonBlack:1` and no fallback banner
  while the emulator was online.
- **Visual review.** The page renders as a light/dark three-column workbench
  (library / device / runtime+config+logs) with the phone frame, AVD picker,
  toolbar, build/log cards.

## v1.3 UI pass verification (2026-11-05)

Using browser control against the real page at 1600x1000:

- **Focus mode:** header Focus hides both side columns (`display:none`), the
  grid becomes one 1272 px column, and the portrait device grows to 700 px.
  Exit focus (or Escape) restores the dashboard.
- **Smooth view end-to-end:** headless Edge, online emulator, canvas 720x1280,
  `nonBlack=1`, no fallback banner, live home screen visible in the page
  screenshot. A sizing race was fixed along the way: the canvas default
  300x150 size no longer overrides the emulator resolution before the first
  decoded frame.
- **One start action:** offline shows only Focus in the header, with a single
  Start in the device card. Online shows Stop in the header.
- **Offline Play:** 41 game Play buttons were disabled while the emulator was
  off; the 5 Build & play project buttons stayed enabled because they boot the
  emulator.
- **Control docks:** Keyboard and Pad are mutually exclusive. In focus mode
  with Pad open, the phone is 293x520 and the pad ends at y=923 above the
  footer at y=946, so the device stays visible while using controls. Keyboard
  uses the same compact dock.
- **Theme coverage:** light theme was checked offline, dark theme online in
  focus mode with Keyboard and Pad.

## End-to-end UI smoke test (2026-11-05, v1.3.0)

After refreshing a fresh authenticated client through browser control:

- The Game Lab page mounted with no main-slot crash (`data-slot-error` empty)
  and no console errors other than the harness's account warning.
- Offline: the header had only **Focus**; 41 game **Play** buttons were
  disabled (the Build & play project buttons remained enabled).
- Focus mode survived a page reload (localStorage), and the side columns were
  hidden with the device at 700 px.
- Starting the emulator and opening Game Lab produced a 720x1280 H.264 canvas
  with `nonBlack=1` and no fallback banner.
- **Play** installed and launched a test game from the library; the host notes
  recorded the install and `dumpsys` showed the game's activity resumed.
- Rotate was recorded by the host (`input rotate`), but the test game is
  portrait-locked so the resolution stayed 720x1280 - correct Android behaviour.
- The Pad's D-pad sent a key (`input key`), and the Keyboard dock sent text
  (`input text`, banner "Text sent.").
- Library search typed "Shadow" and showed three matching builds; after a page
  reload the query was still there.
- Stop emulator returned to the offline card, removed the canvas and left only
  Focus in the header.

## Desktop-shell Start fence fix (v1.3.1)

A live DSH desktop page could render Game Lab and its GET data but every start
failed with "the Game Lab route requires a loopback same-origin browser
request". The desktop shell's POST Origin did not match the webserver Host
spelling. The fence now treats loopback peer + loopback Host as the boundary:
cross-site requests and non-loopback Origin hosts are still refused, while a
missing, `null`, file/custom-protocol or loopback Origin is accepted.

Reproduction with a desktop-like request (Origin `http://localhost:59301`,
Host `127.0.0.1:59301`):

- `POST /emulator {action:"start"}` -> 202, emulator booted online at 720x1280;
- `POST /emulator {action:"stop"}` -> 202, stopped;
- a heartbeat with `Origin: https://evil.example` still returns 403;
- `/diagnose` echoes and logs the Host/Origin/Sec-Fetch-Site headers, and the
  client sends one diagnostic POST per page load.

The fence now logs decisions to `%TEMP%\game-lab-fence.log`; the desktop page's
next load/retry is captured there if a mismatch remains.

## Hidden emulator console (v1.3.2, Windows 11)

Launching the emulator opened a visible Windows Terminal tab titled
`qemu-system-x86_64-headless.exe`. The SDK launcher was spawned with
`detached: true`; Windows gives a detached console app its own console, and the
default terminal host (Windows Terminal) shows it.

Fix: spawn attached with `windowsHide: true` so the launcher and qemu inherit
the host's hidden console. Verified on Windows 11 with Windows Terminal as the
default terminal:

- start -> booting -> online at 720x1280 with **no** WindowsTerminal process;
- no terminal process after Stop either;
- Start/Stop still work; the process tree is `emulator.exe` -> qemu, parented by
  the DSH host.

Tradeoff: the emulator is no longer OS-detached from the host. The leftover
adoption path still works for an emulator launched by hand, but the emulator is
not expected to survive a host restart.

## Linux cloud port (v1.4.0, 2026-11-08)

Host: Ubuntu 24.04 Vultr VM, 12 vCPU, 23 GB RAM, **no `/dev/kvm`** (CPU flagsvmx/svm are not exposed). Android SDK is at `/var/lib/dsh/android/sdk`, cmdline-tools at the sibling
`/var/lib/dsh/android/cmdline/cmdline-tools`, JDK at
`/var/lib/dsh/android/jdk-17.0.21+9`.

- Toolchain auto-detection resolved adb, emulator, aapt2, avdmanager and the
  JDK without `ANDROID_HOME` being set for the DSH service.
- The original Google APIs AVD was replaced with a lean AOSP
  `system-images;android-28;default;x86_64` `gamelab` AVD (the old one was
  backed up under `/var/lib/dsh/avd-backups/`). The emulator boot log recorded
  `Boot completed in 181998 ms`; the plugin adopted the running AVD by exact
  `-avd` token and legacy `ro.kernel.qemu.avd_name`, and reported online at
  720x1280 with ~2.3 GB RSS and ~99% of its pinned CPU.
- A direct `adb exec-out screencap -p` returned a 60 KB, 720x1280 PNG showing
  the launcher, and the plugin's `/frame.png` returned a frame once the frame
  loop had started. A later plugin-owned cold boot reached online in 190 s;
  the frame-loop child was running but no PNG arrived within 60 s, and
  `adb shell input` exceeded the old 15 s timeout. Both are TCG/one-vCPU
  throughput limits, not host-code failures.
- **Performance limit:** with the host policy of one vCPU (pinned to one host
  core), Android 9 + SwiftShader booted but System UI raised multiple ANRs and
  `adb shell input` could take longer than the old 15 s timeouts. The port
  raises Linux shell timeouts to 45 s, adds `ro.hw_timeout_multiplier=20`,
  disables error dialogs/animations on adopt, and prefers lean images. A fully
  interactive game test on this cloud host still needs more CPU for slot 1
  (2-4 vCPUs) or an AVD with a lower resolution; that is a host allocation
  decision, not a code path.
- The Linux port also verified: free-port selection (5554/5556/5558/5560),
  adoption without spawning a duplicate (`gamelab` vs `gamelab_hm` prefix
  bug fixed), emulator stderr captured into boot errors, and resource sampling
  limited to this AVD.

### v1.4.4 combined recovery command (2026-11-09)

- The Launcher/System-UI recovery command is now one `adb shell` round trip;
  `test/guest-recovery.test.mjs` verifies both attempt variants and ordering.
- A live timing attempt was started from HOST_BUILD `2026-11-09.5`, but the
  shared `emulator-5554` was stopped by another session (`stopped (user)`) while
  it was still booting, so this optimization still needs a live timing check.
  The previously verified two-attempt recovery (v1.4.2) remains the baseline.
- v1.4.5: the same device-side command measured **46 s** with a manual
  `adb shell` invocation, longer than the 25 s timeout used in v1.4.4; the
  production timeout is now 60 s. The live run was again cut short by another
  session stopping `emulator-5554` (`stopped (user)`).

### v1.4.3 view-mode preference (2026-11-09)

- Measured on the live one-vCPU guest: `/stream.h264` delivered **one 14.8 KB
  frame in 12 s** (15 kbps, fps 0), while `/frame.png` served a 540x960 frame
  in **0.78 s**. The page therefore defaults to Compat/PNG when the host
  reports `video.preferred: "png"`, without starting the H.264 stream.
- `status.video.preferred` is covered by the integration test. The browser
  default was not screenshot-verified because this Linux host has no Chrome for
  the browser-control plugin; the server field and the client branch were
  reviewed and syntax-checked.

### v1.4.2 automatic guest-UI recovery (2026-11-09)

- Cold boot at 540x960 reached online in 165 s; the first frames were black
  (`/frame.png` 404/13 KB) while `mCurrentFocus=null`/Launcher never drew.
- The watchdog noted `black frame; recovering guest UI (attempt 1)` and
  `no frame after boot; recovering guest UI (attempt 2)`, restarted the
  Launcher, and the next `/frame.png` returned a **48 KB, 540x960 home
  screen** (screenshot inspected). A manual `am force-stop
  com.android.launcher3` reproduced the same recovery before the code change.
- Overlapping recoveries were observed during that run; a `guestUiRecovering`
  guard was added so only one attempt runs at a time (at most two per boot).
  A second live run confirmed the guard: attempt 1 started 10:24:02 and
  finished 10:25:07; attempt 2 started only after that and finished 10:25:51;
  `/frame.png` then returned a 51 KB 540x960 home screen.
- Caveat: the watchdog waits for the raw frame loop to notice black/no-frame;
  recovery can take tens of seconds on the one-vCPU guest.

### v1.4.1 raw frame pipeline (2026-11-09)

- A plugin-owned cold boot at **540x960/240** reached online in **158 s** on the
  one-vCPU guest.
- The Linux raw pipeline returned `/frame.png` in **1.33 s** (540x960 PNG) and
  `/input` returned `{"ok":true}`.
- Direct measurements: at 720x1280 `screencap -p` took **53.7 s** and raw
  `screencap` **9.5 s**; at 540x960 direct PNG took **3.2 s** and raw **2.7 s**.
  The plugin serves the latest raw frame immediately, which is why its
  `/frame.png` was ~1.3 s even when the guest was busy.
- The captured frame was **black**; a direct `screencap -p` was also black and
  logcat showed `ANR in com.android.launcher3` ("no window has focus") while
  `mScreenState=ON`. This is a one-vCPU guest-UI limitation, not a frame
  pipeline failure. The raw conversion was unit-tested against synthetic
  frames; a non-black visual proof still requires more guest CPU.

## Not verified

- The page was exercised at 1600x1000: light offline, dark online with Keyboard
  and Pad. The 1240/920/640 px breakpoints, light-theme live view and very small
  windows were not re-shot in this pass.
- A full game APK install/launch through the v1.3 UI was not repeated; the
  renderer, H.264 path, controls and offline states were.
- ADBKeyboard/CJK text input, audio, camera, Play Store, a physical USB phone
  as target, and multiple simultaneous emulators.
- Auto-creating a brand-new AVD on a machine where `gamelab` does not exist
  (the tested AVD was created by a lab script; the auto-create code writes the
  same keys but was not exercised from a clean machine).
- macOS/Linux host behaviour.
- Any CI: this repository intentionally has no workflows.
