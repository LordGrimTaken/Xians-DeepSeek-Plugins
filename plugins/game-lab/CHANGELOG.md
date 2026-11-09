# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [1.4.5] - 2026-11-09

### Fixed

- Give the combined guest-UI recovery shell command a **60 s** adb timeout.
  The exact command measured **46 s** on the slow guest, longer than the 25 s
  used in v1.4.4, so the earlier timeout could cut off the HOME start before it
  completed. The command remains a single adb round trip.

## [1.4.4] - 2026-11-09

### Changed

- **Faster guest-UI recovery.** Launcher/System-UI recovery now runs as one
  device-side shell command in a single adb round trip instead of three to
  four serialized `adb shell` calls, each of which can burn up to 45 s on a
  one-vCPU guest. The command composition is unit-tested; an attempted live
  timing run was canceled by another session stopping the shared
  `emulator-5554` mid-boot, so the new wall-clock improvement is not yet
  live-measured.

## [1.4.3] - 2026-11-09

### Changed

- **Software-emulated hosts default to the PNG compatibility view.** On Linux
  without KVM the H.264 path measured just one frame in 12 s (15 kbps), while
  the raw-PNG path served a 540x960 frame in under a second. `/status` now
  reports `video.preferred: "png"` for such hosts and the page switches to
  compatibility mode after the first status poll unless the user has already
  chosen a view mode. The Smooth toggle still works.

## [1.4.2] - 2026-11-09

### Added

- **Automatic guest-UI recovery after a software-emulated boot.** On a
  one-vCPU TCG guest the Launcher can be focused but never draw (all frames
  black) or hold the screencap shell so no frame arrives at all. Game Lab now
  detects black/no-frame states for the first two minutes after boot, restarts
  Launcher (then System UI on a second attempt), and restarts the frame loop.
  Recoveries never overlap; at most two attempts are made.
- Raw-frame black detection (`rawFrameIsBlack`) and tests.

### Verified

- A cold boot that produced only black frames recovered to the Android home
  screen automatically; `/frame.png` returned a 48 KB 540x960 image after the
  watchdog ran. See docs/VERIFICATION.md.

## [1.4.1] - 2026-11-09

### Added

- **Host-side raw frame pipeline for software emulation.** On Linux without
  KVM the frame loop now runs plain `screencap` (raw RGBA) and encodes PNG on
  the host instead of making the one-vCPU guest compress PNG. At 540x960 the
  live `/frame.png` response dropped from ~54 s to ~1.3 s; input is immediate.
- Configurable guest geometry (`width`, `height`, `density`) so a constrained
  cloud guest can run at 540x960/240 instead of 720x1280/320.
- Raw-frame splitter and PNG encoder unit tests.

## [1.4.0] - 2026-11-08

### Added

- **Linux host support** (Ubuntu/Vultr cloud): Android SDK and JDK
  auto-detection (`$ANDROID_HOME`, `/var/lib/dsh/android/sdk`, sibling
  `cmdline-tools`, `/var/lib/dsh/android/jdk-*`), Java/PATH env for avdmanager
  and Gradle, and Linux process management.
- Software-emulation launch path: `-accel off` when `/dev/kvm` is absent,
  SwiftShader by default on a headless host, `ro.hw_timeout_multiplier=20`,
  camera-free launch, and a free emulator port chosen per start.
- Lean-image preference when no KVM is available: AOSP/default and lower API
  before Google APIs.
- AVD repair for externally created AVDs: fix a relative/duplicated
  `image.sysdir.1`, remove `disk.dataPartition.path=<temp>`, and normalize
  resolution, GPU, RAM and vCPU settings.
- Linux adoption: an already-running AVD is detected by exact `-avd` token and
  its console port, legacy `ro.kernel.qemu.avd_name` is supported, and a local
  process is waited for instead of spawning a duplicate.
- Emulator health check marks a vanished adb serial as an error, and emulator
  stdout/stderr is captured into boot error messages.
- Resource sampling on Linux sums only this AVD's qemu/emulator processes.

### Fixed

- Start/stop race could leave a start request canceled by a previous stop.
- `gamelab` prefix matching mistakenly treated `gamelab_hm` as the same AVD.
- AVD creation now repairs the image path before first launch.

## [1.3.2] - 2026-11-05

### Fixed

- **A visible Windows Terminal opened when the emulator launched.** The SDK
  emulator was spawned with `detached: true`; Windows gives a detached console
  app its own console, and Windows 11 hands that to Windows Terminal
  (`qemu-system-x86_64-headless.exe` tab). The emulator is now spawned attached
  with `windowsHide: true`, so it and qemu inherit the host's hidden console and
  no terminal window appears. Verified with the emulator booting and online: no
  WindowsTerminal process; Start/Stop still work.

## [1.3.1] - 2026-11-05

### Fixed

- **Start failed in the DSH desktop shell** with "the Game Lab route requires a
  loopback same-origin browser request". The click was rejected by the POST
  fence because the shell's page Origin did not match the webserver Host
  spelling (or was absent/null). The fence now treats a loopback peer plus a
  loopback Host as the trust boundary: it refuses cross-site requests and
  non-loopback Origin hosts, but accepts a missing, `null`, file/custom, or
  loopback Origin for state-changing requests. A diagnostic route
  (`POST /_dsh/game-lab/diagnose`) and a one-shot client report record the
  shell's Host/Origin/Sec-Fetch-Site in `%TEMP%\game-lab-fence.log` so any
  remaining mismatch is inspectable without DevTools.

## [1.3.0] - 2026-11-05

### Added

- **Focus mode**: hides the library and runtime/config/log columns and gives
  the device the page (header button, Escape to exit, remembered per browser).
- **One control dock at a time**: Keyboard and Pad are mutually exclusive, and
  the device shrinks in focus mode while a dock is open so the screen stays
  visible instead of being pushed below the fold.
- **Single start action**: the header no longer duplicates Start while the
  emulator is offline; the device card owns the AVD picker and Start, the header
  owns Stop once online.
- **Offline Play guard**: game Play buttons are disabled with a "Start the
  emulator first" tooltip until the emulator is online (Build & play remains
  enabled because it boots the emulator).

### Fixed

- The H.264 hook reported the canvas default 300x150 as the stream size before
  the first decoded frame, which briefly turned the device into a giant
  landscape frame. Dimensions now come only from a decoded `VideoFrame`.
- Repaired UTF-8 mojibake in the README introduced by a PowerShell write.

## [1.2.1] - 2026-11-05

### Fixed

- **Blank Game Lab page:** `effectiveResolution` was read by the orientation
  computation before its `const` declaration, so the client slot crashed with
  `ReferenceError: Cannot access 'effectiveResolution' before initialization`.
  The value is now declared before its first use.
- **Smooth H.264 view never decoded:** the WebCodecs codec string was built from
  the SPS NAL header byte instead of the profile byte (`avc1.6742c0` instead of
  `avc1.42c029`). The decoder is now configured with an
  AVCDecoderConfigurationRecord and fed AVCC length-prefixed samples, which is
  what an `avc1.*` decoder expects; previously it fell back to Compat with
  "Decoder: Unknown or ambiguous codec name".
- Kept a single warning log when the smooth stream fails so the fallback has a
  diagnosable reason.

## [1.2.0] - 2026-11-05

### Added

- On-screen **Pad** panel: D-pad (arrow keys), A (Enter), B (Back) and
  Start (Menu), for games that expect a controller/keyboard rather than only
  touch.
- **AVD picker** in the offline screen. `/status` now exposes `avds` (up to 40
  installed AVD names); the selected AVD is persisted in `localStorage` and
  sent to `POST /emulator`.
- The game-library search box remembers its last query
  (`dsh.game-lab.query`).
- `HOST_BUILD` bumped for the new status field.

## [1.1.0] - 2026-11-05

### Added

- Smooth H.264 live view: host `host/video.js` streams screenrecord Annex-B
  output through `GET /_dsh/game-lab/stream.h264`; the page decodes it with
  WebCodecs and paints a canvas. Automatic fallback to the PNG stream and a
  Smooth/Compat toolbar toggle.
- `host/build.js`: build-plan detection for plain Gradle and Capacitor
  projects. Capacitor apps run their own `android:apk` script or
  `npm run build` + `npx cap sync android` + Gradle, then install the APK.
- Keyboard panel (ASCII text + Enter/Space/Backspace/Esc) and extra key codes.
- Display stay-awake after boot/adopt (`svc power stayon`,
  `screen_off_timeout`, keyguard dismissed, WAKEUP).
- `phase`, `stepIndex`, `kind` and `apkPath` in the `/status` build object.
- H.264 statistics in `/status` (`fps`, `kbps`, `frames`, `sps`, `pps`).
- Portable test fixtures: the test suite now creates its own APK/project
  fixtures and skips optional real-APK tests instead of depending on a
  developer machine layout.
- Documentation set (`docs/`), MIT license, contributing guide and issue
  templates.

### Fixed

- Build & Play installed stale web assets for Capacitor games.
- Starting a video stream closed its own HTTP response when the first
  SPS+IDR chunk crossed the socket high-water mark.
- The idle timer could stop the emulator in the middle of a long build.
- AAPT2 launchable activity names (bare class names) are normalized to
  `package/class` before `am start`.

## [1.0.0] - 2026-11-05

### Added

- Initial Game Lab plugin: headless AVD lifecycle (boot on demand, idle stop),
  live PNG screen stream, tap/swipe/key/rotate input, game library scan,
  install-and-launch, Gradle Build & Play, logcat tail, runtime readouts,
  loopback/same-origin route fence, unit and integration tests.
