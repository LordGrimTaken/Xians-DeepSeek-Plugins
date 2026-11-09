/**
 * Game Lab host controller.
 *
 * Owns one lean, headless Android emulator for testing the games this user
 * builds. Design goals, in order:
 *   1. Nothing runs until the user presses Start: no emulator, no CPU.
 *   2. A low-spec AVD (720x1280, 2 vCPU, 2 GB RAM, no snapshots) so the
 *      machine keeps its memory; frames are only produced while the page is
 *      watching, and the emulator shuts down after an idle period.
 *   3. The browser talks to this module only through the DSH webserver routes
 *      in routes.js; the page never sees adb and there is no extra port.
 *
 * Everything here is plain ESM with Node builtins, because the plugin runs in
 * the DSH host process and is loaded as a local bundle.
 */

import { spawn, execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { FrameLoop, MultipartWriter } from './frame.js'
import { scanLibrary, apkInfo, resolveAapt2 } from './library.js'
import { detectBuildPlan } from './build.js'
import { VideoLoop } from './video.js'

const IS_WINDOWS = process.platform === 'win32'
const IS_LINUX = process.platform === 'linux'
const PLUGIN = 'game-lab'
/** Bumped when the host module changes so a live reload can be verified. */
export const HOST_BUILD = '2026-11-09.7'

const DEFAULT_CONFIG = {
  /** AVD this panel owns. Created on first start when it is missing. */
  avdName: 'gamelab',
  /** Guest RAM and vCPU count for that AVD. */
  ramMb: 2048,
  cores: 2,
  /** Fixed emulator console port (0 = pick the first free one). On a host
   * that allocates a serial per session this must match the allocated slot. */
  port: 0,
  /** Emulator GPU mode: host (uses the real GPU, lower CPU) or swiftshader_indirect. */
  gpuMode: 'host',
  /** Guest display geometry. Lower resolution is much cheaper on software
   * emulation and is the biggest lever on a one-vCPU cloud guest. */
  width: 720,
  height: 1280,
  density: 320,
  /** Frames per second cap for the live view. Lower = less CPU. */
  maxFps: 8,
  /** Stop the emulator after this many minutes with no page/input activity. */
  idleMinutes: 5,
  /** Where the game library is discovered. */
  gameRoots: [],
  /** Hard bound on a cold boot. */
  bootTimeoutMs: 240000,
  /** Optional explicit SDK directory; auto-detected when empty. */
  sdkDir: null,
}

/** Command name for the current platform. */
function exe(name) {
  return IS_WINDOWS ? `${name}.exe` : name
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Locate one executable name on PATH. */
function findOnPath(name) {
  const extensions = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : ['']
  const entries = String(process.env.PATH ?? '').split(path.delimiter)
  for (const entry of entries) {
    if (entry === '') continue
    for (const extension of extensions) {
      const candidate = path.join(entry, name + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Find avdmanager under an SDK root or the SDK's sibling cmdline-tools tree. */
function findAvdManager(sdkDir) {
  const binName = IS_WINDOWS ? 'avdmanager.bat' : 'avdmanager'
  const roots = []
  const push = (dir) => {
    if (typeof dir !== 'string' || dir === '') return
    if (!roots.includes(dir)) roots.push(dir)
  }
  if (typeof sdkDir === 'string' && sdkDir !== '') {
    push(path.join(sdkDir, 'cmdline-tools', 'latest', 'bin'))
    push(path.join(sdkDir, 'cmdline-tools', 'bin'))
    const cmdlineTools = path.join(sdkDir, 'cmdline-tools')
    try {
      for (const entry of readdirSync(cmdlineTools)) push(path.join(cmdlineTools, entry, 'bin'))
    } catch {
      // cmdline-tools is optional.
    }
    // On Linux cloud images the SDK and cmdline-tools are often siblings:
    // `<root>/sdk` plus `<root>/cmdline/cmdline-tools/bin`.
    const parent = path.dirname(sdkDir)
    push(path.join(parent, 'cmdline', 'cmdline-tools', 'bin'))
    push(path.join(parent, 'cmdline-tools', 'latest', 'bin'))
    push(path.join(parent, 'cmdline-tools', 'bin'))
    try {
      for (const entry of readdirSync(path.join(parent, 'cmdline-tools'))) {
        push(path.join(parent, 'cmdline-tools', entry, 'bin'))
      }
    } catch {
      // no sibling cmdline-tools
    }
  }
  const onPath = findOnPath('avdmanager')
  if (onPath !== null) push(path.dirname(onPath))
  for (const root of roots) {
    const candidate = path.join(root, binName)
    if (existsSync(candidate)) return candidate
  }
  return onPath
}

/** Resolve a Java home for avdmanager and Gradle on Linux/macOS. */
function findJavaHome() {
  const candidates = []
  const push = (dir) => {
    if (typeof dir !== 'string' || dir.trim() === '') return
    const resolved = path.resolve(dir.trim())
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }
  push(process.env.JAVA_HOME)
  push(process.env.JDK_HOME)
  for (const base of [
    path.join(os.homedir(), '.jdks'),
    '/var/lib/dsh/android',
    '/var/lib/dsh/qa',
    '/usr/lib/jvm',
    '/opt/java',
  ]) {
    push(base)
    try {
      for (const entry of readdirSync(base)) {
        if (/jdk|java|temurin|zulu/i.test(entry)) push(path.join(base, entry))
      }
    } catch {
      // not present
    }
  }
  const javaOnPath = findOnPath('java')
  if (javaOnPath !== null) push(path.dirname(path.dirname(javaOnPath)))
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'bin', IS_WINDOWS ? 'java.exe' : 'java'))) return candidate
  }
  return null
}

/** True when Linux KVM is available to this process. */
function hasKvmAcceleration() {
  if (!IS_LINUX) return true
  try {
    accessSync('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/** True when a TCP port is free on loopback. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** Pick the first free even emulator console port from 5554 upward. */
async function pickEmulatorPort() {
  for (let port = 5554; port <= 5680; port += 2) {
    if (await isPortFree(port) && await isPortFree(port + 1)) return port
  }
  return null
}

/** True when an argv string contains `-avd <name>` as a whole token. */
function argsMatchAvd(args, avdName) {
  if (typeof args !== 'string' || typeof avdName !== 'string' || avdName === '') return false
  const escaped = avdName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)-avd\\s+${escaped}(?:\\s|$)`).test(args)
}

/** True when a process is still alive. */
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Read a process's direct children from procfs. */
function processChildren(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
    return text === '' ? [] : text.split(/\s+/).map((value) => Number(value)).filter((value) => Number.isFinite(value))
  } catch {
    return []
  }
}

/**
 * Resolve adb / emulator / aapt2 from an explicit setting, ANDROID_HOME,
 * ANDROID_SDK_ROOT, the platform default SDK path, or PATH.
 */
export function resolveToolchain(settings = {}) {
  const candidates = []
  const push = (dir) => {
    if (typeof dir !== 'string' || dir.trim() === '') return
    const resolved = path.resolve(dir.trim())
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }
  push(settings.sdkDir)
  push(process.env.GAME_LAB_SDK_DIR)
  push(process.env.ANDROID_HOME)
  push(process.env.ANDROID_SDK_ROOT)
  if (IS_WINDOWS) push(path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'))
  if (IS_LINUX) {
    push(path.join(os.homedir(), 'Android', 'Sdk'))
    push(path.join(os.homedir(), 'android', 'sdk'))
    // This cloud host's SDK lives outside $HOME and ANDROID_HOME is not set
    // for the DSH service. Keep the generic locations first.
    push('/var/lib/dsh/android/sdk')
    push('/opt/android-sdk')
    push('/usr/local/android-sdk')
  }
  if (process.platform === 'darwin') push(path.join(os.homedir(), 'Library', 'Android', 'sdk'))

  const adbOnPath = findOnPath('adb')
  if (adbOnPath !== null) push(path.dirname(path.dirname(adbOnPath)))
  const emulatorOnPath = findOnPath('emulator')

  const javaHome = findJavaHome()
  for (const sdkDir of candidates) {
    const adb = path.join(sdkDir, 'platform-tools', exe('adb'))
    const emulator = path.join(sdkDir, 'emulator', exe('emulator'))
    if (existsSync(adb) && existsSync(emulator)) {
      return {
        ok: true,
        sdkDir,
        adb,
        emulator,
        aapt2: resolveAapt2(sdkDir),
        avdmanager: findAvdManager(sdkDir),
        javaHome,
      }
    }
  }

  // Last resort: tools on PATH (emulator launches AVDs from its own SDK root).
  if (adbOnPath !== null || emulatorOnPath !== null) {
    const sdkDir = adbOnPath !== null ? path.dirname(path.dirname(adbOnPath)) : null
    return {
      ok: adbOnPath !== null && emulatorOnPath !== null,
      sdkDir,
      adb: adbOnPath,
      emulator: emulatorOnPath,
      aapt2: sdkDir === null ? null : resolveAapt2(sdkDir),
      avdmanager: findAvdManager(sdkDir),
      javaHome,
      reason: adbOnPath === null || emulatorOnPath === null
        ? 'adb and the emulator launcher must both be installed (Android SDK platform-tools + emulator)'
        : undefined,
    }
  }

  return {
    ok: false,
    sdkDir: null,
    adb: null,
    emulator: null,
    aapt2: null,
    avdmanager: null,
    javaHome,
    reason: 'Android SDK not found: set ANDROID_HOME or the plugin config sdkDir',
  }
}

/** Fill defaults, clamp dangerous values and drop unusable roots. */
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (isRecord(raw)) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (raw[key] !== undefined && raw[key] !== null) config[key] = raw[key]
    }
  }
  const home = os.homedir()
  if (!Array.isArray(config.gameRoots) || config.gameRoots.length === 0) {
    if (IS_WINDOWS) {
      config.gameRoots = [path.join('C:', path.sep, 'Games'), path.join(home, 'Games')]
    } else {
      config.gameRoots = [path.join(home, 'Games')]
      // The cloud workspace tree is the useful default there.
      if (existsSync('/srv/dsh/workspaces')) config.gameRoots.push('/srv/dsh/workspaces')
    }
  }
  config.gameRoots = Array.isArray(config.gameRoots)
    ? config.gameRoots.filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => path.normalize(root))
    : []
  if (config.gameRoots.length === 0) {
    // A bundle config with a Windows-only path (C:\Games) becomes empty on
    // Linux; fall back to platform defaults instead of showing an empty library.
    config.gameRoots = IS_WINDOWS
      ? [path.join('C:', path.sep, 'Games'), path.join(home, 'Games')]
      : [path.join(home, 'Games')]
    if (!IS_WINDOWS && existsSync('/srv/dsh/workspaces')) config.gameRoots.push('/srv/dsh/workspaces')
    config.gameRoots = config.gameRoots.filter((root) => typeof root === 'string' && path.isAbsolute(root))
  }
  config.gameRoots = config.gameRoots.slice(0, 8)
  config.avdName = typeof config.avdName === 'string' && config.avdName.trim() !== '' ? config.avdName.trim() : 'gamelab'
  config.ramMb = clamp(Math.round(Number(config.ramMb) || 2048), 1024, 6144)
  config.cores = clamp(Math.round(Number(config.cores) || 2), 1, 8)
  {
    const requested = Number(config.port)
    config.port = Number.isFinite(requested) && requested > 0
      ? clamp(Math.round(requested / 2) * 2, 5554, 5680)
      : 0
  }
  config.width = clamp(Math.round(Number(config.width) || 720), 320, 1920)
  config.height = clamp(Math.round(Number(config.height) || 1280), 320, 1920)
  config.density = clamp(Math.round(Number(config.density) || 320), 120, 640)
  config.maxFps = clamp(Math.round(Number(config.maxFps) || 8), 2, 20)
  config.idleMinutes = clamp(Math.round(Number(config.idleMinutes) || 5), 1, 120)
  config.bootTimeoutMs = clamp(Math.round(Number(config.bootTimeoutMs) || 240000), 60000, 600000)
  // Software-emulated (TCG) Android 30 boots can take several minutes on a
  // cloud VM with no /dev/kvm.
  if (IS_LINUX && !hasKvmAcceleration() && config.bootTimeoutMs < 600000) config.bootTimeoutMs = 600000
  config.gpuMode = ['host', 'swiftshader_indirect', 'auto'].includes(config.gpuMode) ? config.gpuMode : 'host'
  config.sdkDir = typeof config.sdkDir === 'string' && config.sdkDir.trim() !== '' ? config.sdkDir.trim() : null
  return config
}

/** Promisified execFile with a hard timeout and merged diagnostics. */
function execFileP(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: options.timeoutMs ?? 30000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        cwd: options.cwd,
        env: options.env,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (error) {
          const detail = (err !== '' ? err : out !== '' ? out : errorMessage(error)).trim().slice(0, 800)
          const failure = new Error(`${path.basename(binary)} ${args.join(' ')} failed: ${detail}`)
          failure.stdout = out
          failure.stderr = err
          failure.code = typeof error.code === 'number' ? error.code : null
          reject(failure)
          return
        }
        resolve({ stdout: out, stderr: err, code: 0 })
      },
    )
  })
}

/**
 * One device-side shell command for guest UI recovery. Combining the steps in
 * one adb round trip is much faster than three separate `adb shell` calls on a
 * software-emulated guest, where each call can take up to 45 s.
 */
export function guestRecoveryCommand(attempt = 0) {
  const start = 'am start -a android.intent.action.MAIN -c android.intent.category.HOME'
  return attempt === 0
    ? `am force-stop com.android.launcher3; input keyevent KEYCODE_WAKEUP; ${start}`
    : `am force-stop com.android.systemui; am force-stop com.android.launcher3; input keyevent KEYCODE_WAKEUP; ${start}`
}

/** The interactive half of Game Lab: one emulator plus its library and build jobs. */
export class GameLab {
  constructor(ctx, rawConfig) {
    this.ctx = ctx
    this.config = normalizeConfig(rawConfig)
    this.toolchain = resolveToolchain(this.config)
    this.frameIntervalMs = clamp(Math.round(1000 / this.config.maxFps), 60, 500)
    this.createdAt = Date.now()
    this.disposed = false

    this.emulator = {
      status: 'off',
      avd: null,
      serial: null,
      owned: false,
      bootStartedAt: null,
      bootedAt: null,
      bootElapsedMs: null,
      progress: 0,
      error: null,
      resolution: null,
    }
    this.build = {
      state: 'idle',
      project: null,
      kind: null,
      appRoot: null,
      androidDir: null,
      phase: null,
      phaseId: null,
      stepIndex: 0,
      stepCount: 0,
      steps: [],
      log: [],
      startedAt: null,
      finishedAt: null,
      ok: null,
      apkPath: null,
    }

    this.frameLoop = null
    this.latestFrame = null
    this.streamWriters = new Set()
    this.videoLoop = null
    this.videoWriter = null
    this.videoConsumers = 0
    this.videoDemandUntil = 0
    this.videoRestartTimer = null
    this.videoLastError = null
    this.consumers = 0
    this.frameDemandUntil = 0
    this.lastActivityAt = 0
    this.bootGeneration = 0
    this.emulatorPid = null
    this.emulatorStderr = []
    this.healthMissingSince = 0
    this.guestUiBlackSince = 0
    this.guestUiNoFrameSince = 0
    this.guestUiAttempts = 0
    this.guestUiDeadline = 0
    this.guestUiRecovering = false
    this.buildChild = null
    this.timers = []
    this.avdCache = { at: 0, list: [] }
    this.resources = { at: 0, ramMb: null, cpuPercent: null, sampledAt: null }
    this.gamesCache = { at: 0, value: null }
    this.installedInfo = new Map()
    this.notes = []
    this.pollingLeftover = false
  }

  /** Start the periodic timers. Called once from the plugin's apply(). */
  begin() {
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickIdle()).catch(() => {}) }, 10000))
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickResources()).catch(() => {}) }, 12000))
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickFrames()).catch(() => {}) }, 10000))
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickHealth()).catch(() => {}) }, 10000))
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickGuestUi()).catch(() => {}) }, 8000))
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickVideo()).catch(() => {}) }, 10000))
    this.timers.push(setInterval(() => { Promise.resolve(this.#tickLeftoverEmulator()).catch(() => {}) }, 20000))
    for (const timer of this.timers) timer.unref?.()
    Promise.resolve(this.#tickResources()).catch(() => {})
    Promise.resolve(this.#listAvds()).catch(() => {})
    this.#note(this.toolchain.ok
      ? `ready: sdk=${this.toolchain.sdkDir ?? 'PATH'} aapt2=${this.toolchain.aapt2 ?? 'missing'} avd=${this.config.avdName}`
      : `not ready: ${this.toolchain.reason ?? 'unknown toolchain error'}`)
  }

  /** Snapshot the client page polls. */
  status() {
    const emulator = this.emulator
    return {
      ok: true,
      plugin: PLUGIN,
      hostBuild: HOST_BUILD,
      serverTime: Date.now(),
      emulator: {
        state: emulator.status,
        avd: emulator.avd,
        serial: emulator.serial,
        owned: emulator.owned,
        bootedAt: emulator.bootedAt,
        bootElapsedMs: emulator.bootElapsedMs,
        progress: Math.round(emulator.progress * 100) / 100,
        error: emulator.error,
        resolution: this.#resolution(),
        fps: this.frameLoop !== null && this.frameLoop.running ? this.frameLoop.fps : null,
        ramMb: this.resources.ramMb,
        cpuPercent: this.resources.cpuPercent,
        idleStopAt: this.#idleStopAt(),
        lastActivityAt: this.lastActivityAt > 0 ? this.lastActivityAt : null,
      },
      video: {
        active: this.videoLoop !== null && this.videoLoop.running,
        consumers: this.videoConsumers,
        error: this.videoLastError,
        // Software emulation renders H.264 at well under 1 fps; the host-side
        // raw PNG path is much faster there, so tell the page to default to it.
        preferred: IS_LINUX && !hasKvmAcceleration() ? 'png' : 'h264',
        ...(this.videoLoop === null ? { fps: 0, kbps: 0, frames: 0, sps: false, pps: false, bytes: 0 } : this.videoLoop.stats),
      },
      build: {
        state: this.build.state,
        project: this.build.project,
        kind: this.build.kind,
        phase: this.build.phase,
        phaseId: this.build.phaseId,
        stepIndex: this.build.stepIndex,
        stepCount: this.build.stepCount,
        steps: this.build.steps,
        logTail: this.build.log.length > 0 ? this.build.log.slice(-40).join('\n') : null,
        startedAt: this.build.startedAt,
        finishedAt: this.build.finishedAt,
        ok: this.build.ok,
        apkPath: this.build.apkPath,
      },
      config: {
        avdName: this.config.avdName,
        idleMinutes: this.config.idleMinutes,
        maxFps: this.config.maxFps,
        ramMb: this.config.ramMb,
        cores: this.config.cores,
        port: this.config.port,
        width: this.config.width,
        height: this.config.height,
        density: this.config.density,
        gpuMode: this.config.gpuMode,
        gameRoots: this.config.gameRoots,
      },
      toolchain: {
        ok: this.toolchain.ok,
        reason: this.toolchain.reason ?? null,
        avdmanager: this.toolchain.avdmanager !== null,
        aapt2: this.toolchain.aapt2 !== null,
      },
      avds: this.avdCache.list.slice(0, 40),
      notes: this.notes.slice(-8),
    }
  }

  /** Scan the configured roots for APKs and Gradle game projects. */
  async listGames(force = false) {
    const now = Date.now()
    if (!force && this.gamesCache.value !== null && now - this.gamesCache.at < 15000) return this.gamesCache.value
    const value = await scanLibrary({
      roots: this.config.gameRoots,
      aapt2Path: this.toolchain.aapt2,
      maxGames: 300,
      maxProjects: 40,
      now,
    })
    for (const game of value.games) {
      const known = this.installedInfo.get(game.path)
      if (known !== undefined) {
        game.packageName = game.packageName ?? known.packageName
        game.label = game.label ?? known.label
        game.versionName = game.versionName ?? known.versionName
      }
    }
    value.toolchain = { aapt2: this.toolchain.aapt2, ok: this.toolchain.ok }
    this.gamesCache = { at: now, value }
    return value
  }

  /** True when the emulator can accept input right now. */
  get online() {
    return this.emulator.status === 'online' && typeof this.emulator.serial === 'string'
  }

  /** Mark user/UI activity so the idle timer does not fire. */
  touch(reason = 'activity') {
    this.lastActivityAt = Date.now()
    this.#note(reason)
  }

  /** Keep the frame loop alive for a while (streaming readers). */
  demandFrames(ms = 30000) {
    this.frameDemandUntil = Math.max(this.frameDemandUntil, Date.now() + ms)
  }

  /** Last emulator stderr lines, appended to boot failure messages. */
  #stderrHint() {
    if (!Array.isArray(this.emulatorStderr) || this.emulatorStderr.length === 0) return ''
    return '\n' + this.emulatorStderr.slice(-8).join('\n')
  }

  /** Environment with the SDK's platform-tools and a usable JDK on PATH. */
  #toolchainEnv() {
    const env = { ...process.env }
    if (typeof this.toolchain.sdkDir === 'string') {
      env.ANDROID_HOME = this.toolchain.sdkDir
      env.ANDROID_SDK_ROOT = this.toolchain.sdkDir
    }
    if (typeof this.toolchain.javaHome === 'string') {
      env.JAVA_HOME = this.toolchain.javaHome
      env.PATH = path.join(this.toolchain.javaHome, 'bin') + path.delimiter + (env.PATH ?? '')
    }
    return env
  }

  /** vCPU count. The cloud host pins every emulator to one host CPU. */
  #effectiveCores() {
    if (IS_LINUX) return 1
    return this.config.cores
  }

  /**
   * The console port to launch on. When `config.port` is set, never fall back
   * to another slot's port: a busy port means another session owns it and
   * starting there would collide with that session's adb serial.
   */
  async #selectPort() {
    if (this.config.port !== 0) {
      const free = await isPortFree(this.config.port) && await isPortFree(this.config.port + 1)
      if (!free) {
        throw new Error(`configured emulator port ${this.config.port} is already in use; refusing to take another session's serial`)
      }
      return this.config.port
    }
    const port = await pickEmulatorPort()
    if (port === null) throw new Error('no free Android emulator console port in 5554-5680')
    return port
  }

  /** Pick a GPU mode that works without a display/GPU (cloud Linux). */
  #effectiveGpuMode() {
    if (this.config.gpuMode !== 'auto') {
      if (IS_LINUX && this.config.gpuMode === 'host' && !process.env.DISPLAY) return 'swiftshader_indirect'
      return this.config.gpuMode
    }
    if (IS_LINUX) {
      if (!process.env.DISPLAY) return 'swiftshader_indirect'
      return hasKvmAcceleration() ? 'host' : 'swiftshader_indirect'
    }
    return 'host'
  }

  /** The AVD root used by avdmanager on this platform. */
  #avdRoot() {
    return process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android', 'avd')
  }

  /** Read the AVD name from either the modern or legacy qemu property. */
  async #deviceAvdName(serial) {
    for (const property of ['ro.boot.qemu.avd_name', 'ro.kernel.qemu.avd_name']) {
      const result = await this.#shell(serial, ['getprop', property], 6000).catch(() => null)
      const value = result === null ? '' : result.stdout.trim()
      if (value !== '') return value
    }
    return ''
  }

  /** Find a local emulator process for this AVD, including its console port. */
  async #findLocalEmulatorInfo(avdName) {
    if (!IS_LINUX) return null
    const result = await execFileP('ps', ['-eo', 'pid=,args='], { timeoutMs: 10000 }).catch(() => null)
    if (result === null) return null
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match === null) continue
      const args = match[2]
      if (!argsMatchAvd(args, avdName)) continue
      if (!/qemu-system|emulator/.test(args)) continue
      const portMatch = /(?:^|\s)-port\s+(\d+)/.exec(args)
      return { pid: Number(match[1]), port: portMatch === null ? 5554 : Number(portMatch[1]) }
    }
    return null
  }

  /** Find a local emulator process for this AVD (even if adb is not ready). */
  async #findLocalEmulatorProcess(avdName) {
    if (!IS_LINUX) return null
    const result = await execFileP('ps', ['-eo', 'pid=,args='], { timeoutMs: 10000 }).catch(() => null)
    if (result === null) return null
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match === null) continue
      const args = match[2]
      if (!argsMatchAvd(args, avdName)) continue
      if (!/qemu-system|emulator/.test(args)) continue
      return Number(match[1])
    }
    return null
  }

  /** Find an already-online emulator only when its AVD name matches. */
  async #findOnlineDeviceForAvd(avdName) {
    const devices = await this.#devices().catch(() => [])
    for (const device of devices) {
      if (device.state !== 'device' || !device.serial.startsWith('emulator-')) continue
      if (await this.#deviceAvdName(device.serial) === avdName) return device.serial
    }
    return null
  }

  /** Wait until a device has finished booting; used when adopting one. */
  async #waitForBoot(serial, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const completed = await this.#shell(serial, ['getprop', 'sys.boot_completed'], 6000).catch(() => null)
      if (completed !== null && completed.stdout.trim() === '1') return true
      await sleep(1500)
    }
    return false
  }

  /** Normalize an existing (possibly externally created) Game Lab AVD. */
  async #repairAvd(avdName) {
    const configPath = path.join(this.#avdRoot(), `${avdName}.avd`, 'config.ini')
    if (!existsSync(configPath)) return
    let text = await readFile(configPath, 'utf8').catch(() => '')
    if (text === '') return
    const before = text
    text = text.replace(/^\s*disk\.dataPartition\.path\s*=.*$/gm, '')
    // avdmanager run from a sibling cmdline-tools root can write a relative
    // image.sysdir.1 such as "sdk/system-images/..." which the emulator then
    // resolves under the SDK root twice. Point it at the real installed image.
    const imageLine = /^\s*image\.sysdir\.1\s*=\s*(.*)$/m.exec(text)
    let targetLine = /^\s*target\s*=\s*android-(\d+)\s*$/m.exec(text)
    if (targetLine === null) {
      const ini = await readFile(path.join(this.#avdRoot(), `${avdName}.ini`), 'utf8').catch(() => '')
      targetLine = /^\s*target\s*=\s*android-(\d+)\s*$/m.exec(ini)
    }
    const abiLine = /^\s*abi\.type\s*=\s*([\w-]+)\s*$/m.exec(text)
    const sdkDir = this.toolchain.sdkDir
    let imagePath = imageLine === null ? '' : imageLine[1].trim()
    const imageExists = (candidate) => candidate !== '' && existsSync(candidate)
    if (!imageExists(imagePath) && typeof sdkDir === 'string') {
      if (!path.isAbsolute(imagePath)) imagePath = path.join(sdkDir, imagePath)
    }
    if (!imageExists(imagePath) && typeof sdkDir === 'string' && targetLine !== null) {
      const api = `android-${targetLine[1]}`
      const abi = abiLine === null ? 'x86_64' : abiLine[1]
      const root = path.join(sdkDir, 'system-images', api)
      try {
        const vendors = readdirSync(root)
        const ordered = ['default', ...vendors.filter((entry) => entry !== 'default')]
        for (const vendor of ordered) {
          const candidate = path.join(root, vendor, abi)
          if (existsSync(candidate)) { imagePath = candidate; break }
        }
      } catch {
        // no matching image; leave the original path for the emulator's error.
      }
    }
    if (imageExists(imagePath)) {
      const normalizedImage = imagePath.endsWith(path.sep) ? imagePath : imagePath + path.sep
      if (/^\s*image\.sysdir\.1\s*=/m.test(text)) {
        text = text.replace(/^\s*image\.sysdir\.1\s*=.*$/m, `image.sysdir.1 = ${normalizedImage}`)
      } else {
        text = `${text.trimEnd()}\nimage.sysdir.1 = ${normalizedImage}\n`
      }
    }
    const values = {
      'hw.lcd.width': String(this.config.width),
      'hw.lcd.height': String(this.config.height),
      'hw.lcd.density': String(this.config.density),
      'hw.ramSize': String(this.config.ramMb),
      'hw.cpu.ncore': String(this.#effectiveCores()),
      'hw.gpu.enabled': 'yes',
      'hw.gpu.mode': this.#effectiveGpuMode(),
      'hw.keyboard': 'yes',
      'fastboot.forceColdBoot': 'yes',
      'fastboot.forceFastBoot': 'no',
    }
    for (const [key, value] of Object.entries(values)) {
      const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*.*$`, 'm')
      if (pattern.test(text)) text = text.replace(pattern, `${key} = ${value}`)
      else text = `${text.trimEnd()}\n${key} = ${value}\n`
    }
    if (text !== before) {
      await writeFile(configPath, text, 'utf8')
      this.#note(`normalized AVD ${avdName} (${this.#effectiveGpuMode()}, ${this.#effectiveCores()} vCPU)`)
    }
  }

  /** Kill one process and every descendant on Linux. */
  async #killProcessTree(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return
    if (IS_WINDOWS) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
      return
    }
    const victims = new Set()
    const collect = (current) => {
      if (victims.has(current)) return
      victims.add(current)
      for (const child of processChildren(current)) collect(child)
    }
    collect(pid)
    for (const victim of victims) {
      try { process.kill(victim, 'SIGTERM') } catch { /* already gone */ }
    }
    await sleep(800)
    for (const victim of victims) {
      try { process.kill(victim, 'SIGKILL') } catch { /* already gone */ }
    }
  }

  /** Boot the configured AVD headless, or adopt an already-running emulator. */
  async startEmulator(options = {}) {
    if (this.disposed) throw new Error('Game Lab is shutting down')
    if (this.emulator.status === 'online' || this.emulator.status === 'booting') return this.status()
    if (this.emulator.status === 'stopping') {
      const deadline = Date.now() + 20000
      while (this.emulator.status === 'stopping' && Date.now() < deadline) await sleep(250)
      if (this.emulator.status === 'stopping') throw new Error('the emulator is still stopping; try again once it is off')
    }
    if (!this.toolchain.ok) {
      this.emulator.status = 'error'
      this.emulator.error = this.toolchain.reason ?? 'Android SDK not found'
      return this.status()
    }
    const generation = ++this.bootGeneration
    const requestedAvd = typeof options.avd === 'string' && options.avd.trim() !== '' ? options.avd.trim() : this.config.avdName

    this.touch('start requested')
    this.emulatorPid = null
    this.emulator = {
      status: 'booting',
      avd: requestedAvd,
      serial: null,
      owned: true,
      bootStartedAt: Date.now(),
      bootedAt: null,
      bootElapsedMs: null,
      progress: 0.02,
      error: null,
      resolution: null,
    }

    try {
      // Fast path: if this AVD already has a local qemu process, adopt its
      // exact port instead of enumerating every adb device/property.
      const localInfo = await this.#findLocalEmulatorInfo(requestedAvd)
      if (localInfo !== null) {
        const expectedSerial = `emulator-${localInfo.port}`
        this.#note(`AVD ${requestedAvd} is running as pid ${localInfo.pid} (${expectedSerial}); waiting for boot`)
        const deadline = Date.now() + this.config.bootTimeoutMs
        let localSerial = null
        while (Date.now() < deadline) {
          if (generation !== this.bootGeneration) return this.status()
          if (!isProcessAlive(localInfo.pid)) {
            this.#note(`AVD ${requestedAvd} pid ${localInfo.pid} exited while waiting; starting our own`)
            break
          }
          const devices = await this.#devices().catch(() => [])
          if (devices.some((device) => device.serial === expectedSerial && device.state === 'device')) {
            localSerial = expectedSerial
            break
          }
          this.emulator.progress = Math.min(0.9, this.emulator.progress + 0.01)
          await sleep(3000)
        }
        if (localSerial !== null) {
          if (await this.#waitForBoot(localSerial, this.config.bootTimeoutMs)) {
            await this.#adopt(localSerial, requestedAvd, generation)
            return this.status()
          }
          throw new Error(`AVD ${requestedAvd} is running (pid ${localInfo.pid}) but Android did not finish booting in time`)
        }
        if (isProcessAlive(localInfo.pid)) {
          throw new Error(`AVD ${requestedAvd} is running (pid ${localInfo.pid}) but did not register as ${expectedSerial} in time`)
        }
      }

      // Never adopt a different AVD: this host can have other emulators
      // (coc, coc28, ...) running from other sessions. On Linux a running AVD
      // always has a local qemu process (handled above); skip the adb property
      // scan so another session's slow/unreachable device cannot block start.
      const matching = IS_LINUX ? null : await this.#findOnlineDeviceForAvd(requestedAvd)
      if (matching !== null) {
        if (await this.#waitForBoot(matching, this.config.bootTimeoutMs)) {
          await this.#adopt(matching, requestedAvd, generation)
          return this.status()
        }
        throw new Error(`AVD "${requestedAvd}" is already running (${matching}) but Android did not finish booting`)
      }

      // Another session may have started the same AVD by hand; never spawn a
      // duplicate (the emulator refuses with "multiple emulators with the same
      // AVD"). Wait for that instance to register and boot instead.
      const localPid = await this.#findLocalEmulatorProcess(requestedAvd)
      if (localPid !== null) {
        this.#note(`AVD ${requestedAvd} is already running as pid ${localPid}; waiting for adb`)
        const deadline = Date.now() + this.config.bootTimeoutMs
        let adoptedSerial = null
        let localExited = false
        while (Date.now() < deadline) {
          if (generation !== this.bootGeneration) return this.status()
          if (!isProcessAlive(localPid)) {
            localExited = true
            this.#note(`AVD ${requestedAvd} pid ${localPid} exited while waiting; starting our own`)
            break
          }
          adoptedSerial = await this.#findOnlineDeviceForAvd(requestedAvd).catch(() => null)
          if (adoptedSerial !== null) break
          this.emulator.progress = Math.min(0.9, this.emulator.progress + 0.01)
          await sleep(3000)
        }
        if (adoptedSerial === null && !localExited) {
          throw new Error(`AVD ${requestedAvd} is already running (pid ${localPid}) but did not register with adb in time; stop that emulator or wait`)
        }
        if (adoptedSerial !== null) {
          if (!(await this.#waitForBoot(adoptedSerial, this.config.bootTimeoutMs))) {
            throw new Error(`AVD ${requestedAvd} is running (pid ${localPid}) but Android did not finish booting in time`)
          }
          await this.#adopt(adoptedSerial, requestedAvd, generation)
          return this.status()
        }
      }

      const before = new Set((await this.#devices()).map((device) => device.serial))
      await this.#ensureAvd(requestedAvd)
      if (generation !== this.bootGeneration) return this.status()

      const gpuMode = this.#effectiveGpuMode()
      const port = await this.#selectPort()
      const args = [
        '-avd', requestedAvd,
        '-no-window',
        '-no-audio',
        '-no-boot-anim',
        '-no-snapshot',
        '-gpu', gpuMode,
        '-memory', String(this.config.ramMb),
        '-cores', String(this.#effectiveCores()),
        '-no-metrics',
      ]
      if (IS_LINUX) {
        args.push('-camera-back', 'none', '-camera-front', 'none', '-prop', 'ro.hw_timeout_multiplier=20')
        if (!hasKvmAcceleration()) args.push('-accel', 'off')
      }
      if (port !== null) args.push('-port', String(port))
      this.#note(`launching ${requestedAvd} gpu=${gpuMode}${port === null ? '' : ` port=${port}`}${IS_LINUX && !hasKvmAcceleration() ? ' accel=off' : ''}`)
      this.emulatorStderr = []
      const child = spawn(this.toolchain.emulator, args, {
        // Do NOT detach: a detached console app gets its own console window,
        // which Windows 11 hands to Windows Terminal (the visible terminal the
        // user sees). With windowsHide, keeping the process attached to the
        // host's hidden console keeps qemu's console hidden too.
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: this.toolchain.sdkDir ?? undefined,
      })
      let spawnFailure = null
      let launcherExit = null
      const capture = (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim() === '') continue
          this.emulatorStderr.push(line.length > 500 ? line.slice(0, 500) + '...' : line)
        }
        if (this.emulatorStderr.length > 80) this.emulatorStderr.splice(0, this.emulatorStderr.length - 80)
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', capture)
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', capture)
      child.once('error', (error) => {
        spawnFailure = error
      })
      child.once('exit', (code, signal) => {
        launcherExit = { code, signal }
      })
      child.unref()
      this.emulatorPid = typeof child.pid === 'number' ? child.pid : null
      this.#note(`emulator launch pid=${String(this.emulatorPid)} avd=${requestedAvd}`)

      const deadline = Date.now() + this.config.bootTimeoutMs
      let serial = null
      while (Date.now() < deadline) {
        if (generation !== this.bootGeneration) return this.status()
        if (spawnFailure !== null) throw new Error(`emulator launcher failed: ${errorMessage(spawnFailure)}`)
        if (launcherExit !== null) {
          throw new Error(`emulator exited during boot (code=${String(launcherExit.code)} signal=${String(launcherExit.signal)})${this.#stderrHint()}`)
        }
        const devices = await this.#devices().catch(() => [])
        serial = devices.find(
          (device) => device.state === 'device' && device.serial.startsWith('emulator-') && !before.has(device.serial),
        )?.serial ?? null
        if (serial !== null) break
        this.emulator.progress = Math.min(0.6, this.emulator.progress + 0.02)
        await sleep(1000)
      }
      if (serial === null) throw new Error(`the emulator did not appear within ${Math.round(this.config.bootTimeoutMs / 1000)} s`)
      this.emulator.serial = serial

      while (Date.now() < deadline) {
        if (generation !== this.bootGeneration) return this.status()
        if (launcherExit !== null) {
          throw new Error(`emulator exited during boot (code=${String(launcherExit.code)} signal=${String(launcherExit.signal)})${this.#stderrHint()}`)
        }
        const completed = await this.#shell(serial, ['getprop', 'sys.boot_completed'], 6000).catch(() => null)
        if (completed !== null && completed.stdout.trim() === '1') break
        this.emulator.progress = Math.min(0.95, this.emulator.progress + 0.015)
        await sleep(1500)
      }
      const bootCompleted = await this.#shell(serial, ['getprop', 'sys.boot_completed'], 6000).catch(() => null)
      if (bootCompleted === null || bootCompleted.stdout.trim() !== '1') {
        throw new Error('the emulator appeared but Android did not finish booting in time')
      }

      if (generation !== this.bootGeneration) return this.status()
      await this.#markOnline(serial, requestedAvd, true, this.emulator.bootStartedAt)
      return this.status()
    } catch (error) {
      if (typeof this.emulatorPid === 'number') {
        await this.#killSpawnedEmulator().catch(() => {})
        this.emulatorPid = null
      }
      if (generation === this.bootGeneration && this.emulator.status !== 'off') {
        this.emulator.status = 'error'
        this.emulator.error = errorMessage(error) + this.#stderrHint()
        this.emulator.progress = 0
        this.#note(`boot failed: ${errorMessage(error)}`)
      }
      return this.status()
    }
  }

  /** Stop the emulator, freeing its RAM and CPU. */
  async stopEmulator(options = {}) {
    if (this.emulator.status === 'off' || this.emulator.status === 'stopping') return this.status()
    const reason = typeof options.reason === 'string' ? options.reason : 'user'
    this.bootGeneration += 1
    const serial = this.emulator.serial
    this.emulator.status = 'stopping'
    this.emulator.progress = 0
    this.#stopFrameLoop()
    this.#stopVideoLoop()
    for (const writer of this.streamWriters) writer.close()
    this.streamWriters.clear()
    this.consumers = 0

    if (serial !== null) {
      await this.#exec(['-s', serial, 'emu', 'kill'], 8000).catch(() => null)
      const deadline = Date.now() + 10000
      let stillThere = true
      while (Date.now() < deadline) {
        const devices = await this.#devices().catch(() => [])
        stillThere = devices.some((device) => device.serial === serial)
        if (!stillThere) break
        await sleep(500)
      }
      if (stillThere) await this.#killSpawnedEmulator()
    } else if (typeof this.emulatorPid === 'number') {
      await this.#killSpawnedEmulator()
    }
    this.emulator = {
      status: 'off',
      avd: null,
      serial: null,
      owned: false,
      bootStartedAt: null,
      bootedAt: null,
      bootElapsedMs: null,
      progress: 0,
      error: null,
      resolution: null,
    }
    this.emulatorPid = null
    this.resources = { at: 0, ramMb: null, cpuPercent: null, sampledAt: null }
    this.#note(`stopped (${reason})`)
    return this.status()
  }

  /** Install one APK and launch it. */
  async installAndLaunch(apkPath) {
    if (!this.online) throw new Error('the emulator is not running - start Game Lab first')
    if (typeof apkPath !== 'string' || apkPath.trim() === '') throw new Error('an APK path is required')
    const absolute = path.resolve(apkPath)
    let info = null
    try {
      info = await stat(absolute)
    } catch {
      throw new Error(`APK not found: ${absolute}`)
    }
    if (!info.isFile() || !/\.apk$/i.test(absolute)) throw new Error('that path is not an APK file')

    const serial = this.emulator.serial
    const before = await this.#installedPackages(serial)
    const result = await this.#exec(['-s', serial, 'install', '-r', '-g', absolute], 180000, true)
    const output = `${result.stdout}\n${result.stderr}`
    if (!/Success/i.test(output)) {
      throw new Error(`adb install failed: ${output.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`)
    }

    let details = null
    if (typeof this.toolchain.aapt2 === 'string') {
      details = await apkInfo(this.toolchain.aapt2, absolute).catch(() => null)
    }
    let packageName = details?.packageName ?? null
    if (packageName === null) {
      const after = await this.#installedPackages(serial)
      const added = [...after].filter((entry) => !before.has(entry))
      packageName = added.length === 1 ? added[0] : null
    }
    if (packageName === null) throw new Error('the APK installed but its package name could not be determined')

    const launchableActivity = details?.launchableActivity ?? null
    await this.#launchPackage(packageName, launchableActivity).catch((error) => {
      throw new Error(`installed ${packageName} but launching it failed: ${errorMessage(error)}`)
    })
    this.installedInfo.set(absolute, {
      packageName,
      label: details?.label ?? null,
      versionName: details?.versionName ?? null,
    })
    this.touch(`installed ${packageName}`)
    return {
      ok: true,
      packageName,
      label: details?.label ?? null,
      versionName: details?.versionName ?? null,
      launched: true,
    }
  }

  /** Launch an already installed package. */
  async launchPackage(packageName) {
    if (!this.online) throw new Error('the emulator is not running - start Game Lab first')
    if (typeof packageName !== 'string' || packageName.trim() === '') throw new Error('a package name is required')
    await this.#launchPackage(packageName.trim(), null)
    this.touch(`launched ${packageName}`)
    return { ok: true, packageName }
  }

  /**
   * Build a game project and install the result. Detection covers plain
   * Gradle projects and Capacitor apps (web build + `cap sync` + Gradle), so
   * the APK contains the current web bundle instead of stale assets.
   */
  async buildProject(projectPath) {
    if (this.build.state === 'running') throw new Error('a build is already running')
    if (typeof projectPath !== 'string' || projectPath.trim() === '') throw new Error('a project path is required')
    const plan = await detectBuildPlan(projectPath).catch(() => null)
    if (plan === null || plan.steps.length === 0) {
      throw new Error(`no buildable Gradle or Capacitor project found at ${path.resolve(projectPath)}`)
    }
    const startedAt = Date.now()
    this.build = {
      state: 'running',
      project: plan.projectRoot,
      kind: plan.kind,
      appRoot: plan.appRoot,
      androidDir: plan.androidDir,
      phase: plan.steps[0].label,
      phaseId: plan.steps[0].id,
      stepIndex: 0,
      stepCount: plan.steps.length,
      steps: plan.steps.map((step) => step.label),
      log: [
        `[game-lab] ${plan.kind === 'capacitor' ? 'Capacitor' : 'Gradle'} project: ${plan.projectRoot}`,
        ...plan.notes.map((note) => `[game-lab] ${note}`),
      ],
      startedAt,
      finishedAt: null,
      ok: null,
      apkPath: null,
    }
    this.touch(`build started ${plan.projectRoot}`)
    if (!this.online) {
      // One click "build & play": bring the emulator up while Gradle runs.
      this.#note('build: booting the emulator for the install step')
      Promise.resolve().then(() => this.startEmulator({})).catch(() => {})
    }
    Promise.resolve()
      .then(() => this.#runBuildPlan(plan, startedAt))
      .catch((error) => {
        this.build.state = 'error'
        this.build.ok = false
        this.build.finishedAt = Date.now()
        this.#appendBuildLog(Buffer.from(`[game-lab] ${errorMessage(error)}`))
        this.#note(`build failed: ${errorMessage(error)}`)
      })
    return { ok: true, state: 'running', kind: plan.kind, steps: plan.steps.map((step) => step.id) }
  }

  /** Run every build step in order, then install and launch the APK. */
  async #runBuildPlan(plan, startedAt) {
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]
      this.build.stepIndex = index
      this.build.phaseId = step.id
      this.build.phase = step.label
      this.#appendBuildLog(Buffer.from(`[game-lab] > ${step.label}  (${step.cwd})`))
      const code = await this.#runBuildStep(step)
      if (code !== 0) throw new Error(`${step.label} failed (exit ${String(code)})`)
    }
    await this.#finishBuild(plan, startedAt)
  }

  /** Run one build step through the platform shell; resolves with its code. */
  #runBuildStep(step) {
    return new Promise((resolve) => {
      const env = this.#toolchainEnv()
      const line = `${step.command} ${step.args.join(' ')}`
      const child = IS_WINDOWS
        ? spawn('cmd.exe', ['/d', '/s', '/c', line], {
          cwd: step.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
        : spawn('sh', ['-c', line], {
          cwd: step.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
      this.buildChild = child
      child.stdout?.on('data', (chunk) => this.#appendBuildLog(chunk))
      child.stderr?.on('data', (chunk) => this.#appendBuildLog(chunk))
      let timedOut = false
      let settled = false
      const finish = (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.buildChild = null
        resolve(timedOut ? -1 : code)
      }
      const timeout = setTimeout(() => {
        timedOut = true
        this.#appendBuildLog(Buffer.from(`[game-lab] ${step.label} timed out after 12 minutes`))
        this.#killBuildTree()
      }, 12 * 60 * 1000)
      timeout.unref?.()
      child.once('error', (error) => {
        this.#appendBuildLog(Buffer.from(`[game-lab] ${errorMessage(error)}`))
        finish(-1)
      })
      child.once('close', (code) => finish(typeof code === 'number' ? code : -1))
    })
  }

  /** Append build output to the ring buffer the page polls. */
  #appendBuildLog(chunk) {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      this.build.log.push(line.length > 500 ? `${line.slice(0, 500)}...` : line)
    }
    if (this.build.log.length > 500) this.build.log.splice(0, this.build.log.length - 500)
  }

  /** Send one touch/key/rotation event. Coordinates are normalized 0..1. */
  async input(action) {
    if (!this.online) throw new Error('the emulator is not running - start Game Lab first')
    if (!isRecord(action) || typeof action.kind !== 'string') throw new Error('input requires a kind')
    const serial = this.emulator.serial
    const kind = action.kind
    const dimensions = this.#resolution() ?? { width: 720, height: 1280 }

    switch (kind) {
      case 'tap': {
        const point = this.#point(action.x, action.y, dimensions)
        await this.#shell(serial, ['input', 'tap', String(point.x), String(point.y)], 15000)
        break
      }
      case 'swipe': {
        const from = this.#point(action.fromX, action.fromY, dimensions)
        const to = this.#point(action.toX, action.toY, dimensions)
        const duration = clamp(Math.round(Number(action.durationMs) || 260), 50, 5000)
        await this.#shell(serial, ['input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), String(duration)], 20000)
        break
      }
      case 'key': {
        const keyCode = KEY_CODES[String(action.name)]
        if (keyCode === undefined) throw new Error(`unknown key ${JSON.stringify(action.name)}`)
        await this.#shell(serial, ['input', 'keyevent', keyCode], 15000)
        break
      }
      case 'text': {
        const text = typeof action.text === 'string' ? action.text : ''
        if (text === '') throw new Error('text input requires text')
        if (!/^[A-Za-z0-9 .,!?@_+=:/%-]+$/.test(text)) {
          throw new Error('only ASCII text is supported without ADBKeyboard installed on the device')
        }
        await this.#shell(serial, ['input', 'text', text.replace(/ /g, '%s')], 15000)
        break
      }
      case 'rotate': {
        const orientation = action.orientation === 'landscape' ? 1 : 0
        await this.#shell(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0'], 10000)
        await this.#shell(serial, ['settings', 'put', 'system', 'user_rotation', String(orientation)], 10000)
        this.demandFrames(30000)
        break
      }
      default:
        throw new Error(`unknown input kind ${JSON.stringify(kind)}`)
    }
    this.touch(`input ${kind}`)
    return { ok: true, kind }
  }

  /** Tail the device log, optionally restricted to one app's process. */
  async readLogs(query = {}) {
    if (!this.online) throw new Error('the emulator is not running - start Game Lab first')
    const serial = this.emulator.serial
    const lineCount = clamp(Math.round(Number(query.lines) || 200), 10, 500)
    const packageName = typeof query.packageName === 'string' ? query.packageName.trim() : ''
    let pid = null
    if (packageName !== '') {
      const resolved = await this.#shell(serial, ['pidof', packageName], 8000).catch(() => null)
      const text = resolved === null ? '' : resolved.stdout.trim()
      pid = /^\d+/.test(text) ? text.split(/\s+/)[0] : null
    }
    const args = ['-s', serial, 'logcat', '-d', '-v', 'time', '-t', String(lineCount)]
    if (pid !== null) args.push(`--pid=${pid}`)
    const result = await this.#exec(args, 20000, true)
    let lines = result.stdout.split('\n').filter((line) => line.trim() !== '')
    if (pid === null && packageName !== '') lines = lines.filter((line) => line.includes(packageName))
    return { ok: true, lines: lines.slice(-lineCount), packageName: packageName === '' ? null : packageName }
  }

  /** Serve the live multipart frame stream on one HTTP response. */
  openStream(res) {
    const writer = new MultipartWriter(res)
    this.streamWriters.add(writer)
    this.consumers += 1
    this.demandFrames(120000)
    this.#ensureFrameLoop()
    if (this.latestFrame !== null) writer.writeFrame(this.latestFrame)
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.streamWriters.delete(writer)
      writer.close()
      this.consumers = Math.max(0, this.consumers - 1)
      this.demandFrames(60000)
      res.off('close', release)
    }
    res.on('close', release)
    return release
  }

  /**
   * Serve the live H.264 bitstream on one HTTP response. Only one viewer at a
   * time, and the stream always starts fresh so it begins with SPS/PPS and a
   * keyframe the decoder can configure from.
   */
  openVideoStream(res) {
    if (!this.online) return { ok: false, code: 'emulator_offline', error: 'the emulator is not running' }
    if (this.videoWriter !== null) return { ok: false, code: 'video_busy', error: 'a live video stream is already open' }
    if (this.videoLoop !== null) this.#stopVideoLoop()
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    })
    const writer = { res, closed: false }
    this.videoWriter = writer
    this.videoConsumers = 1
    this.videoDemandUntil = Date.now() + 120000
    this.#ensureVideoLoop()
    const release = () => {
      if (writer.closed) return
      writer.closed = true
      if (this.videoWriter === writer) this.videoWriter = null
      this.videoConsumers = 0
      this.videoDemandUntil = Date.now() + 30000
      try {
        res.end()
      } catch {
        // Already gone.
      }
      res.off('close', release)
      res.off('error', release)
    }
    res.on('close', release)
    res.on('error', release)
    return { ok: true }
  }

  /** One PNG of the newest frame, waiting briefly for the loop to warm up. */
  async framePng() {
    if (!this.online) return undefined
    this.demandFrames(60000)
    const loop = this.#ensureFrameLoop()
    if (this.latestFrame !== null) return this.latestFrame.png
    if (loop === null) return undefined
    const frame = await loop.waitForFrame(3000)
    return frame === undefined ? undefined : frame.png
  }

  /** Tear everything down (plugin unload / app quit). */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.#killBuildTree()
    for (const writer of this.streamWriters) writer.close()
    this.streamWriters.clear()
    this.#stopVideoLoop()
    if (this.emulator.status !== 'off') await this.stopEmulator({ reason: 'shutdown' }).catch(() => {})
    this.#stopFrameLoop()
    this.#note('disposed')
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  #note(message) {
    const line = `${new Date().toISOString().slice(11, 19)} ${message}`
    this.notes.push(line)
    if (this.notes.length > 40) this.notes.shift()
  }

  #resolution() {
    if (this.latestFrame !== null) return { width: this.latestFrame.width, height: this.latestFrame.height }
    return this.emulator.resolution
  }

  #idleStopAt() {
    if (this.emulator.status !== 'online' || this.lastActivityAt === 0) return null
    return this.lastActivityAt + this.config.idleMinutes * 60000
  }

  #point(x, y, dimensions) {
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('input coordinates must be numbers')
    const width = dimensions.width
    const height = dimensions.height
    return {
      x: Math.round(clamp(nx, 0, 1) * Math.max(1, width - 1)),
      y: Math.round(clamp(ny, 0, 1) * Math.max(1, height - 1)),
    }
  }

  async #exec(args, timeoutMs = 30000, allowFailure = false) {
    if (typeof this.toolchain.adb !== 'string') throw new Error(this.toolchain.reason ?? 'adb not found')
    try {
      return await execFileP(this.toolchain.adb, args, { timeoutMs })
    } catch (error) {
      if (allowFailure) return { stdout: error.stdout ?? '', stderr: error.stderr ?? errorMessage(error), code: error.code ?? 1 }
      throw error
    }
  }

  async #shell(serial, args, timeoutMs = 20000) {
    if (typeof this.toolchain.adb !== 'string') throw new Error(this.toolchain.reason ?? 'adb not found')
    // A 1-vCPU software-emulated Android can take tens of seconds for a shell
    // command while the guest is busy. Do not fail a user action because of it.
    const effective = IS_LINUX && !hasKvmAcceleration() ? Math.max(timeoutMs, 45000) : timeoutMs
    return execFileP(this.toolchain.adb, ['-s', serial, 'shell', ...args], { timeoutMs: effective })
  }

  async #execBinary(binary, args, timeoutMs = 30000) {
    if (typeof binary !== 'string') throw new Error('binary not found')
    return execFileP(binary, args, { timeoutMs })
  }

  async #devices() {
    if (typeof this.toolchain.adb !== 'string') return []
    const { stdout } = await this.#exec(['devices', '-l'], 15000)
    const devices = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 2) continue
      const serial = parts[0]
      const state = parts[1]
      const details = {}
      for (const part of parts.slice(2)) {
        const index = part.indexOf(':')
        if (index > 0) details[part.slice(0, index)] = part.slice(index + 1)
      }
      devices.push({ serial, state, model: details.model ?? null, product: details.product ?? null, avd: details.avd ?? null })
    }
    return devices
  }

  async #listAvds() {
    if (Date.now() - this.avdCache.at < 60000 && this.avdCache.list.length > 0) return this.avdCache.list
    if (typeof this.toolchain.emulator !== 'string') return []
    try {
      const { stdout } = await this.#execBinary(this.toolchain.emulator, ['-list-avds'], 20000)
      const list = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, 40)
      this.avdCache = { at: Date.now(), list }
      return list
    } catch {
      return this.avdCache.list
    }
  }

  async #ensureAvd(avdName) {
    const existing = await this.#listAvds()
    if (existing.includes(avdName)) {
      await this.#repairAvd(avdName)
      return
    }
    const avdmanager = this.toolchain.avdmanager
    if (typeof avdmanager !== 'string') {
      throw new Error(`AVD "${avdName}" does not exist and avdmanager was not found; create it in Android Studio or with the SDK cmdline-tools`)
    }
    const imageId = await this.#pickSystemImage()
    if (imageId === null) throw new Error(`AVD "${avdName}" does not exist and no x86_64 Android system image is installed to create it from`)
    this.#note(`creating AVD ${avdName} from ${imageId}`)
    await this.#runAvdManager(avdmanager, ['create', 'avd', '-n', avdName, '-k', imageId, '-d', 'pixel_5', '--force'])
    const configPath = path.join(this.#avdRoot(), `${avdName}.avd`, 'config.ini')
    if (!existsSync(configPath)) throw new Error(`avdmanager finished but ${configPath} is missing`)
    const current = await readFile(configPath, 'utf8').catch(() => '')
    const values = {
      'hw.lcd.width': String(this.config.width),
      'hw.lcd.height': String(this.config.height),
      'hw.lcd.density': String(this.config.density),
      'hw.ramSize': String(this.config.ramMb),
      'hw.cpu.ncore': String(this.#effectiveCores()),
      'hw.gpu.enabled': 'yes',
      'hw.gpu.mode': this.#effectiveGpuMode(),
      'hw.keyboard': 'yes',
      'showDeviceFrame': 'no',
      'disk.dataPartition.size': '2G',
      'fastboot.forceColdBoot': 'yes',
      'fastboot.forceFastBoot': 'no',
    }
    let next = current
    for (const [key, value] of Object.entries(values)) {
      // AVD config.ini is written as "key = value" by avdmanager; tolerate both.
      const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*.*$`, 'm')
      if (pattern.test(next)) next = next.replace(pattern, `${key} = ${value}`)
      else next = `${next.trimEnd()}\n${key} = ${value}\n`
    }
    await writeFile(configPath, next, 'utf8')
    // avdmanager can write a relative image.sysdir.1 under a sibling SDK root;
    // normalize it immediately so the first launch works too.
    await this.#repairAvd(avdName)
    this.avdCache = { at: 0, list: [] }
  }

  async #pickSystemImage() {
    const sdkDir = this.toolchain.sdkDir
    if (typeof sdkDir !== 'string') return null
    const root = path.join(sdkDir, 'system-images')
    const preferred = []
    try {
      for (const api of await readdir(root)) {
        for (const vendor of await readdir(path.join(root, api))) {
          for (const abi of await readdir(path.join(root, api, vendor))) {
            const candidate = path.join(root, api, vendor, abi)
            if (!existsSync(candidate)) continue
            const imageId = `system-images;${api};${vendor};${abi}`
            preferred.push({ imageId, score: /x86_64/i.test(abi) ? 2 : /arm64/i.test(abi) ? 1 : 0, api })
          }
        }
      }
    } catch {
      return null
    }
    const apiNumber = (api) => {
      const match = /android-(\d+)/.exec(api)
      return match === null ? 0 : Number(match[1])
    }
    const softwareOnly = IS_LINUX && !hasKvmAcceleration()
    preferred.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (softwareOnly) {
        // Prefer the lean AOSP image and the lower API when every guest runs on
        // TCG: Google APIs on API 30 is far too slow with one vCPU.
        const aDefault = /;default;/.test(a.imageId) ? 1 : 0
        const bDefault = /;default;/.test(b.imageId) ? 1 : 0
        if (aDefault !== bDefault) return bDefault - aDefault
        return apiNumber(a.api) - apiNumber(b.api)
      }
      return apiNumber(b.api) - apiNumber(a.api)
    })
    return preferred.length > 0 ? preferred[0].imageId : null
  }

  #runAvdManager(avdmanager, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(avdmanager, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.#toolchainEnv(),
      })
      let output = ''
      child.stdout?.on('data', (chunk) => { output += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8') })
      child.once('error', (error) => reject(new Error(`avdmanager failed to start: ${errorMessage(error)}`)))
      child.once('close', (code) => {
        if (code === 0) resolve(output)
        else reject(new Error(`avdmanager exited with code ${String(code)}: ${output.trim().slice(0, 600)}`))
      })
      // avdmanager may ask whether to create a custom hardware profile.
      try {
        child.stdin?.write('no\n')
        child.stdin?.end()
      } catch {
        // stdin may already be gone.
      }
    })
  }

  async #adopt(serial, avdName, generation) {
    this.emulator.serial = serial
    this.emulator.progress = 0.98
    const resolvedAvd = await this.#deviceAvdName(serial) || avdName
    if (generation !== this.bootGeneration) return
    this.emulator.owned = false
    await this.#markOnline(serial, resolvedAvd, false, Date.now())
  }

  async #markOnline(serial, avdName, owned, bootStartedAt) {
    this.emulator.status = 'online'
    this.emulator.serial = serial
    this.emulator.avd = avdName
    this.emulator.owned = owned
    this.emulator.bootedAt = Date.now()
    this.emulator.bootElapsedMs = bootStartedAt === null ? null : Date.now() - bootStartedAt
    this.emulator.progress = 1
    this.emulator.error = null
    this.touch('online')
    // Start frames before the (slow) best-effort device preparation so a
    // software-emulated guest can show its screen immediately.
    this.#ensureFrameLoop()
    Promise.resolve(this.#tickResources()).catch(() => {})
    this.#shell(serial, ['wm', 'size'], 8000).then((size) => {
      const match = /(\d+)x(\d+)/.exec(size.stdout)
      if (match !== null) this.emulator.resolution = { width: Number(match[1]), height: Number(match[2]) }
    }).catch(() => {})
    this.#prepareDevice(serial).catch(() => {})
    // A cold TCG boot on one vCPU can leave a focused Launcher that never
    // draws, so every screencap is black. #tickGuestUi detects the black frame
    // and restarts the Launcher/System UI once or twice during the first
    // two minutes; no focus-property guess is needed.
    this.guestUiBlackSince = 0
    this.guestUiNoFrameSince = 0
    this.guestUiAttempts = 0
    this.guestUiDeadline = Date.now() + 120000
    this.guestUiRecovering = false
    this.#note(`online ${serial} (${avdName}) boot=${this.emulator.bootElapsedMs === null ? '?' : Math.round(this.emulator.bootElapsedMs / 1000) + 's'}`)
  }

  /**
   * Keep the emulator display awake: a sleeping display freezes both the game
   * and screenrecord, and the lock screen would hide the game we launched.
   */
  async #prepareDevice(serial) {
    await this.#shell(serial, ['svc', 'power', 'stayon', 'true'], 10000).catch(() => {})
    await this.#shell(serial, ['settings', 'put', 'system', 'screen_off_timeout', '2147483647'], 10000).catch(() => {})
    // Software emulation on one vCPU can trigger System UI ANR dialogs during
    // boot; hide error dialogs and stop animations so the game stays usable.
    for (const [scope, key, value] of [
      ['global', 'hide_error_dialogs', '1'],
      ['global', 'window_animation_scale', '0'],
      ['global', 'transition_animation_scale', '0'],
      ['global', 'animator_duration_scale', '0'],
    ]) {
      await this.#shell(serial, ['settings', 'put', scope, key, value], 10000).catch(() => {})
    }
    await this.#shell(serial, ['am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS'], 10000).catch(() => {})
    await this.#shell(serial, ['wm', 'dismiss-keyguard'], 10000).catch(() => {})
    await this.#shell(serial, ['input', 'keyevent', 'KEYCODE_WAKEUP'], 10000).catch(() => {})
  }

  /**
   * Recover a booted-but-black Launcher on a software-emulated guest. The
   * Launcher can be ANR'd with no focused window; force-stopping it makes
   * ActivityManager start a fresh instance and the home screen renders.
   */
  async #recoverGuestUi(serial, attempt) {
    // A screencap child that is stuck behind an unresponsive Launcher is
    // restarted as part of the same recovery.
    this.#stopFrameLoop()
    // One adb round trip instead of several; a slow guest wastes tens of
    // seconds per `adb shell` invocation. allowFailure so a timeout still
    // leaves recovery best-effort.
    await this.#exec(
      ['-s', serial, 'shell', guestRecoveryCommand(attempt)],
      60000,
      true,
    ).catch(() => {})
    this.#ensureFrameLoop()
    this.demandFrames(30000)
    this.#note(`guest UI recovery sent (attempt ${attempt + 1})`)
  }

  async #launchPackage(packageName, launchableActivity) {
    const serial = this.emulator.serial
    let component = normalizeComponent(packageName, launchableActivity)
    if (component === null) {
      const resolved = await this.#shell(serial, [
        'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', packageName,
      ], 20000).catch(() => null)
      if (resolved !== null) {
        const lines = resolved.stdout.split('\n').map((line) => line.trim()).filter((line) => line.includes('/'))
        component = lines.length > 0 ? lines[lines.length - 1] : null
      }
    }
    let launched = false
    if (component !== null) {
      const result = await this.#shell(serial, ['am', 'start', '-W', '-n', component], 30000).catch(() => null)
      const output = result === null ? '' : `${result.stdout}\n${result.stderr}`
      launched = result !== null && !/^Error/im.test(output) && !/does not exist|not found/i.test(output)
      if (!launched) this.#note(`am start failed for ${component}: ${output.trim().slice(0, 200)}`)
    }
    if (!launched) {
      // Fall back to the category launch used by launchers; some manifests only
      // declare the MAIN/LAUNCHER intent and no directly startable component.
      const fallback = await this.#shell(serial, [
        'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1',
      ], 30000).catch(() => null)
      const output = fallback === null ? '' : `${fallback.stdout}\n${fallback.stderr}`
      launched = fallback !== null && !/No activities found|aborted|Error/im.test(output)
      if (!launched) throw new Error(`could not launch ${packageName}: ${output.trim().slice(0, 300)}`)
    }
    this.demandFrames(60000)
  }

  async #installedPackages(serial) {
    const result = await this.#shell(serial, ['pm', 'list', 'packages', '-3'], 20000).catch(() => null)
    const packages = new Set()
    if (result === null) return packages
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('package:')) packages.add(trimmed.slice('package:'.length))
    }
    return packages
  }

  #ensureFrameLoop() {
    if (this.disposed || !this.online) return null
    const serial = this.emulator.serial
    if (this.frameLoop !== null && this.frameLoop.running && this.frameLoop.serial === serial) {
      this.demandFrames(30000)
      return this.frameLoop
    }
    this.#stopFrameLoop()
    const loop = new FrameLoop({
      adb: this.toolchain.adb,
      serial,
      intervalMs: this.frameIntervalMs,
      // Software-emulated guests encode PNG far too slowly; fetch raw frames
      // and do the PNG encoding on the host instead.
      raw: IS_LINUX && !hasKvmAcceleration(),
    })
    loop.addListener((frame) => this.#onFrame(frame))
    loop.start()
    this.frameLoop = loop
    this.demandFrames(30000)
    return loop
  }

  #onFrame(frame) {
    if (this.disposed) return
    this.latestFrame = frame
    this.emulator.resolution = { width: frame.width, height: frame.height }
    for (const writer of this.streamWriters) writer.writeFrame(frame)
  }

  #stopFrameLoop() {
    if (this.frameLoop !== null) {
      this.frameLoop.stop()
      this.frameLoop = null
      // Killing the host-side adb child can leave the device-side screencap
      // shell running; clean it up so a stopped view costs nothing.
      const serial = this.emulator.serial
      if (typeof serial === 'string' && serial !== '') {
        this.#shell(serial, ['pkill', '-f', 'screencap'], 8000).catch(() => {})
      }
    }
    this.latestFrame = null
  }

  /** Start (or reuse) the screenrecord H.264 loop for the online device. */
  #ensureVideoLoop() {
    if (this.disposed || !this.online) return null
    const serial = this.emulator.serial
    if (this.videoLoop !== null && this.videoLoop.running && this.videoLoop.serial === serial) {
      this.videoDemandUntil = Math.max(this.videoDemandUntil, Date.now() + 60000)
      return this.videoLoop
    }
    // Keep the HTTP response that openVideoStream just claimed; only the old
    // screenrecord process is replaced.
    this.#stopVideoLoop(true)
    const loop = new VideoLoop({ adb: this.toolchain.adb, serial })
    loop.onExit = (detail) => {
      const stderr = loop.stderrLines
      this.videoLastError = stderr.length > 0 ? `${detail}: ${stderr[stderr.length - 1]}` : detail
      this.#note(`video loop ended (${detail})`)
      if (this.disposed || !this.online) return
      if (this.videoConsumers === 0 && Date.now() > this.videoDemandUntil) return
      if (this.videoRestartTimer !== null) return
      this.videoRestartTimer = setTimeout(() => {
        this.videoRestartTimer = null
        if (this.disposed || !this.online) return
        if (this.videoConsumers === 0 && Date.now() > this.videoDemandUntil) return
        this.#ensureVideoLoop()
      }, 800)
      this.videoRestartTimer.unref?.()
    }
    loop.addListener((chunk) => this.#broadcastVideo(chunk))
    loop.start()
    this.videoLoop = loop
    this.videoLastError = null
    this.videoDemandUntil = Math.max(this.videoDemandUntil, Date.now() + 60000)
    return loop
  }

  /** Forward one encoded chunk to the single live viewer. */
  #broadcastVideo(chunk) {
    const writer = this.videoWriter
    if (writer === null || writer.closed) return
    try {
      // Never end the response just because one write crosses the socket's
      // high-water mark - a 20 KB SPS+IDR chunk does that every time. Node
      // buffers the rest and the 100-500 kbps stream drains immediately on
      // loopback. Only a genuinely stuck client (several MB queued) is cut
      // off, and then the page reconnects for a fresh keyframe.
      writer.res.write(chunk)
      if (typeof writer.res.writableLength === 'number' && writer.res.writableLength > 8 * 1024 * 1024) {
        writer.closed = true
        this.videoWriter = null
        this.videoConsumers = 0
        this.videoDemandUntil = Date.now() + 30000
        try {
          writer.res.end()
        } catch {
          // Already gone.
        }
      }
    } catch {
      writer.closed = true
      this.videoWriter = null
      this.videoConsumers = 0
      this.videoDemandUntil = Date.now() + 30000
    }
  }

  #stopVideoLoop(preserveWriter = false) {
    if (this.videoRestartTimer !== null) {
      clearTimeout(this.videoRestartTimer)
      this.videoRestartTimer = null
    }
    if (this.videoLoop !== null) {
      this.videoLoop.stop()
      this.videoLoop = null
    }
    if (preserveWriter) return
    const writer = this.videoWriter
    if (writer !== null) {
      writer.closed = true
      this.videoWriter = null
      try {
        writer.res.end()
      } catch {
        // Already gone.
      }
    }
    this.videoConsumers = 0
  }

  async #tickVideo() {
    if (this.disposed || !this.online) {
      if (this.videoLoop !== null || this.videoWriter !== null) this.#stopVideoLoop()
      return
    }
    if (this.videoConsumers > 0 && (this.videoLoop === null || !this.videoLoop.running)) {
      this.#ensureVideoLoop()
      return
    }
    if (this.videoConsumers === 0 && this.videoLoop !== null && Date.now() > this.videoDemandUntil) {
      this.#stopVideoLoop()
    }
  }

  async #tickIdle() {
    if (this.disposed || this.emulator.status !== 'online') return
    // A Gradle build can outlast the idle window; never kill the emulator out
    // from under an install that is about to happen.
    if (this.build.state === 'running') return
    if (this.lastActivityAt === 0) return
    if (Date.now() - this.lastActivityAt < this.config.idleMinutes * 60000) return
    this.#note('idle timeout')
    this.stopEmulator({ reason: 'idle' }).catch(() => {})
  }

  async #tickFrames() {
    if (this.disposed || !this.online) {
      if (this.frameLoop !== null) this.#stopFrameLoop()
      return
    }
    if (this.frameLoop !== null && !this.frameLoop.running) {
      this.frameLoop.reset()
      this.frameLoop.start()
    }
    if (this.frameLoop === null) return
    if (this.consumers > 0) return
    if (Date.now() < this.frameDemandUntil) return
    this.frameLoop.stop()
    this.frameLoop = null
    this.latestFrame = null
  }

  async #tickLeftoverEmulator() {
    if (this.disposed || this.pollingLeftover) return
    if (!this.toolchain.ok || this.emulator.status !== 'off') return
    this.pollingLeftover = true
    try {
      const devices = await this.#devices().catch(() => [])
      const runaway = devices.find((device) => device.state === 'device' && device.serial.startsWith('emulator-'))
      if (runaway === undefined) return
      const avdName = await this.#deviceAvdName(runaway.serial)
      if (avdName !== this.config.avdName) return
      this.emulator = {
        status: 'booting',
        avd: avdName,
        serial: runaway.serial,
        owned: false,
        bootStartedAt: null,
        bootedAt: null,
        bootElapsedMs: null,
        progress: 0.98,
        error: null,
        resolution: null,
      }
      await this.#markOnline(runaway.serial, avdName, false, null)
    } finally {
      this.pollingLeftover = false
    }
  }

  async #tickGuestUi() {
    if (this.disposed || !IS_LINUX || hasKvmAcceleration() || this.emulator.status !== 'online') {
      this.guestUiBlackSince = 0
      return
    }
    if (this.guestUiDeadline !== 0 && Date.now() > this.guestUiDeadline) return
    const loop = this.frameLoop
    if (loop === null || loop.latest === undefined) {
      // No frame at all can also mean the guest is stuck behind a broken
      // Launcher (the frame child is blocked in screencap).
      if (this.guestUiNoFrameSince === 0) this.guestUiNoFrameSince = Date.now()
      if (this.guestUiAttempts < 2 && !this.guestUiRecovering && Date.now() - this.guestUiNoFrameSince > 15000) {
        this.guestUiNoFrameSince = Date.now()
        const attempt = this.guestUiAttempts
        this.guestUiAttempts += 1
        this.guestUiRecovering = true
        this.#note(`no frame after boot; recovering guest UI (attempt ${attempt + 1})`)
        await this.#recoverGuestUi(this.emulator.serial, attempt).catch(() => {}).finally(() => {
          this.guestUiRecovering = false
        })
      }
      return
    }
    this.guestUiNoFrameSince = 0
    if (loop.latestIsBlack !== true) {
      this.guestUiBlackSince = 0
      return
    }
    if (this.guestUiAttempts >= 2 || this.guestUiRecovering) return
    if (this.guestUiBlackSince === 0) {
      this.guestUiBlackSince = Date.now()
      return
    }
    if (Date.now() - this.guestUiBlackSince < 8000) return
    this.guestUiBlackSince = Date.now()
    const attempt = this.guestUiAttempts
    this.guestUiAttempts += 1
    this.guestUiRecovering = true
    this.#note(`black frame; recovering guest UI (attempt ${attempt + 1})`)
    await this.#recoverGuestUi(this.emulator.serial, attempt).catch(() => {}).finally(() => {
      this.guestUiRecovering = false
    })
  }

  async #tickHealth() {
    if (this.disposed || this.emulator.status !== 'online') {
      this.healthMissingSince = 0
      return
    }
    const serial = this.emulator.serial
    if (typeof serial !== 'string') return
    const devices = await this.#devices().catch(() => [])
    const present = devices.some((device) => device.serial === serial)
    if (present) {
      this.healthMissingSince = 0
      return
    }
    if (this.healthMissingSince === 0) {
      this.healthMissingSince = Date.now()
      return
    }
    if (Date.now() - this.healthMissingSince < 15000) return
    this.healthMissingSince = 0
    this.#stopFrameLoop()
    this.#stopVideoLoop()
    for (const writer of this.streamWriters) writer.close()
    this.streamWriters.clear()
    this.consumers = 0
    if (this.emulator.owned && typeof this.emulatorPid === 'number') {
      await this.#killSpawnedEmulator().catch(() => {})
      this.emulatorPid = null
    }
    this.emulator.status = 'error'
    this.emulator.error = `emulator ${serial} disappeared (adb no longer lists it)`
    this.emulator.serial = null
    this.emulator.resolution = null
    this.#note(`emulator ${serial} disappeared; marked error`)
  }

  async #tickResources() {
    if (this.disposed || this.emulator.status !== 'online') return
    if (Date.now() - this.resources.at < 8000) return
    let ramKb = 0
    let cpu = 0
    let count = 0
    if (IS_WINDOWS) {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$rows = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -match '^(qemu-system|emulator)' } | Select-Object Name, IDProcess, PercentProcessorTime, WorkingSet",
        "@($rows) | ConvertTo-Json -Compress",
      ].join('; ')
      const result = await this.#execBinary('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 12000).catch(() => null)
      if (result === null) return
      let rows = []
      try {
        const parsed = JSON.parse(result.stdout.trim() === '' ? '[]' : result.stdout)
        rows = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        return
      }
      for (const row of rows) {
        if (!isRecord(row)) continue
        const workingSet = Number(row.WorkingSet)
        const processor = Number(row.PercentProcessorTime)
        if (Number.isFinite(workingSet)) ramKb += workingSet / 1024
        if (Number.isFinite(processor)) cpu += processor
        count += 1
      }
    } else {
      // Sum only the processes for THIS AVD; the host can run other emulators.
      const avd = this.emulator.avd
      const result = await this.#execBinary('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=,args='], 12000).catch(() => null)
      if (result === null) return
      for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
        if (match === null) continue
        const args = match[5]
        if (!argsMatchAvd(args, avd) || !/qemu-system|emulator/.test(args)) continue
        ramKb += Number(match[3])
        cpu += Number(match[4])
        count += 1
      }
    }
    this.resources = {
      at: Date.now(),
      ramMb: count === 0 ? null : Math.round(ramKb / 1024),
      cpuPercent: count === 0 ? null : Math.round(cpu),
      sampledAt: Date.now(),
    }
  }

  async #finishBuild(plan, startedAt) {
    const roots = Array.isArray(plan.searchRoots) && plan.searchRoots.length > 0 ? plan.searchRoots : [plan.androidDir]
    let apkPath = null
    let apkMtime = 0
    for (const root of roots) {
      const candidate = await findNewestApk(root, startedAt - 5000)
      if (candidate === null) continue
      const info = await stat(candidate).catch(() => null)
      const mtime = info === null ? 0 : info.mtimeMs
      if (apkPath === null || mtime > apkMtime) {
        apkPath = candidate
        apkMtime = mtime
      }
    }
    if (apkPath === null) {
      // A fully up-to-date build writes no APK at all; reuse the newest
      // existing build output instead of reporting a failed build.
      for (const root of roots) {
        const candidate = await findNewestApk(root, 0)
        if (candidate === null) continue
        const info = await stat(candidate).catch(() => null)
        const mtime = info === null ? 0 : info.mtimeMs
        if (apkPath === null || mtime > apkMtime) {
          apkPath = candidate
          apkMtime = mtime
        }
      }
      if (apkPath !== null) this.#appendBuildLog(Buffer.from(`[game-lab] no new APK (build was up to date); using ${apkPath}`))
    }
    if (apkPath === null) throw new Error('the build succeeded but no APK was found under build/outputs')
    this.build.apkPath = apkPath
    this.#appendBuildLog(Buffer.from(`[game-lab] installing ${apkPath}`))
    const ready = await this.#awaitOnline(150000)
    if (!ready) throw new Error('the build succeeded but the emulator did not come online to install it')
    const installed = await this.installAndLaunch(apkPath)
    this.build.state = 'done'
    this.build.ok = true
    this.build.finishedAt = Date.now()
    this.build.phase = 'Done'
    this.#appendBuildLog(Buffer.from(`[game-lab] built and installed ${installed.packageName ?? ''}`.trim()))
    this.touch(`build done ${plan.projectRoot}`)
  }

  /** Wait for the emulator to become usable, used by the build-install step. */  async #awaitOnline(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.online) return true
      if (this.emulator.status === 'error') return false
      await sleep(1500)
    }
    return this.online
  }

  #killBuildTree() {
    const child = this.buildChild
    this.buildChild = null
    if (child === null || typeof child.pid !== 'number') return
    try {
      if (IS_WINDOWS) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
      } else {
        child.kill('SIGKILL')
      }
    } catch {
      // Best effort.
    }
  }

  async #killSpawnedEmulator() {
    if (typeof this.emulatorPid !== 'number') return
    try {
      await this.#killProcessTree(this.emulatorPid)
    } catch {
      // Best effort.
    }
    await sleep(1000)
  }
}

const KEY_CODES = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  menu: 'KEYCODE_MENU',
  space: 'KEYCODE_SPACE',
  escape: 'KEYCODE_ESCAPE',
  tab: 'KEYCODE_TAB',
  dpad_up: 'KEYCODE_DPAD_UP',
  dpad_down: 'KEYCODE_DPAD_DOWN',
  dpad_left: 'KEYCODE_DPAD_LEFT',
  dpad_right: 'KEYCODE_DPAD_RIGHT',
}

/**
 * aapt2 badging reports the launchable activity as a bare class name
 * (`com.pkg.MainActivity`); `am start -n` needs `package/class`. Accept either
 * form and produce a component string, or null when there is none.
 */
function normalizeComponent(packageName, activity) {
  if (typeof activity !== 'string' || activity.trim() === '') return null
  const name = activity.trim()
  if (name.includes('/')) return name
  if (name.startsWith('.')) return `${packageName}/${name}`
  if (name.startsWith(`${packageName}.`)) return `${packageName}/${name}`
  return `${packageName}/${name}`
}

/** Walk a project's build outputs and return the newest APK. */
async function findNewestApk(root, notBefore) {
  const found = []
  const visit = async (dir, depth) => {
    if (depth < 0) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.gradle' || entry.name === 'intermediates') continue
        await visit(full, depth - 1)
      } else if (entry.isFile() && /\.apk$/i.test(entry.name)) {
        try {
          const info = await stat(full)
          if (info.mtimeMs >= notBefore) found.push({ path: full, mtimeMs: info.mtimeMs })
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }
  await visit(root, 8)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.length > 0 ? found[0].path : null
}
