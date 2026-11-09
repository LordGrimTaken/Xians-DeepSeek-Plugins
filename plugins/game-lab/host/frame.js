/**
 * In-process PNG frame pipeline for a headless Android emulator.
 *
 * One persistent `adb exec-out` child runs a `screencap -p` loop on the
 * device; this module splits the concatenated PNG byte stream into complete
 * frames and hands them to listeners. The web route serves the newest frame
 * as a `multipart/x-mixed-replace` body, which Chromium renders in an <img>
 * exactly like MJPEG. No screen recording, no inner port, no file churn.
 *
 * The splitter walks PNG chunk headers (signature, length + type + CRC until
 * IEND) instead of scanning image data, so a stray marker inside pixel data
 * can never cut a frame. If the stream derails it resyncs at the next
 * signature rather than stalling.
 *
 * Design notes are our own implementation; the ping-pong buffer approach was
 * suggested by the MIT-licensed @zseven-w/dsh-android frame-source module.
 */

import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IEND_TYPE = 0x49454e44 // 'IEND'
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const MAX_UNSYNCED_BYTES = 1024 * 1024
const STDERR_LINE_MAX = 240
export const STREAM_BOUNDARY = 'gamelab-frame'

// ---------------------------------------------------------------------------
// Raw `screencap` frames
//
// `screencap -p` compresses the PNG on the device. On a one-vCPU software
// guest that compression takes ~54 s for one 720x1280 frame; plain
// `screencap` (raw RGBA) took ~9.5 s and is encoded to PNG here on the host.
// The Android screencap stream starts with a 16-byte header: width, height,
// format, then one padding word; pixel data follows as little-endian RGBA.
// ---------------------------------------------------------------------------

const RAW_HEADER_BYTES = 16
const MAX_RAW_FRAME_BYTES = 4096 * 4096 * 4 + RAW_HEADER_BYTES
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data])
  out.writeUInt32BE(crc32(crcInput), 8 + data.length)
  return out
}

/** Convert one raw `screencap` frame (little-endian RGBA) to a PNG. */
export function rawScreencapToPng(raw, headerBytes = RAW_HEADER_BYTES) {
  if (!Buffer.isBuffer(raw) || raw.length < headerBytes + 4) throw new Error('raw frame is too small')
  const width = raw.readUInt32LE(0)
  const height = raw.readUInt32LE(4)
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('raw frame has invalid dimensions')
  const pixelBytes = width * height * 4
  if (raw.length < headerBytes + pixelBytes) throw new Error('raw frame is truncated')
  const source = raw.subarray(headerBytes, headerBytes + pixelBytes)
  const rowLength = 1 + width * 4
  const rows = Buffer.alloc(height * rowLength)
  for (let y = 0; y < height; y += 1) {
    const base = y * rowLength
    rows[base] = 0 // PNG filter: none
    source.copy(rows, base + 1, y * width * 4, (y + 1) * width * 4)
    // Screenshots are opaque; raw buffers can carry a zero X/alpha byte.
    for (let x = 0; x < width; x += 1) rows[base + 1 + x * 4 + 3] = 255
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** True when every sampled RGB pixel in a raw frame is black. */
export function rawFrameIsBlack(raw, headerBytes = RAW_HEADER_BYTES) {
  if (!Buffer.isBuffer(raw) || raw.length < headerBytes + 4) return false
  const width = raw.readUInt32LE(0)
  const height = raw.readUInt32LE(4)
  if (width < 1 || height < 1 || width > 4096 || height > 4096) return false
  const total = width * height
  const dataStart = headerBytes
  if (raw.length < dataStart + total * 4) return false
  const step = Math.max(1, Math.floor(total / 4096))
  for (let pixel = 0; pixel < total; pixel += step) {
    const offset = dataStart + pixel * 4
    if (raw[offset] !== 0 || raw[offset + 1] !== 0 || raw[offset + 2] !== 0) return false
  }
  return true
}

/** Incremental splitter over a raw `screencap` byte stream. */
export class RawFrameSplitter {
  #buffer = Buffer.alloc(0)
  #headerBytes
  /** @type {boolean | null} */
  lastFrameBlack = null

  constructor(options = {}) {
    this.#headerBytes = Number.isInteger(options.headerBytes) ? options.headerBytes : RAW_HEADER_BYTES
  }

  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames = []
    for (;;) {
      if (this.#buffer.length < this.#headerBytes) return frames
      const width = this.#buffer.readUInt32LE(0)
      const height = this.#buffer.readUInt32LE(4)
      if (width < 1 || height < 1 || width > 4096 || height > 4096) {
        this.#buffer = this.#buffer.subarray(1)
        continue
      }
      const frameLength = this.#headerBytes + width * height * 4
      if (frameLength > MAX_RAW_FRAME_BYTES) {
        this.#buffer = this.#buffer.subarray(1)
        continue
      }
      if (this.#buffer.length < frameLength) return frames
      const raw = this.#buffer.subarray(0, frameLength)
      this.#buffer = this.#buffer.subarray(frameLength)
      this.lastFrameBlack = rawFrameIsBlack(raw, this.#headerBytes)
      try {
        frames.push(rawScreencapToPng(raw, this.#headerBytes))
      } catch {
        // Skip a malformed frame and keep scanning.
      }
    }
  }
}

/** Pixel size of a PNG from its IHDR chunk, without decoding the image. */
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return undefined
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  if (buffer.readUInt32BE(12) !== 0x49484452) return undefined // 'IHDR'
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width === 0 || height === 0) return undefined
  return { width, height }
}

/** Incremental splitter over a byte stream of back-to-back PNG images. */
export class PngFrameSplitter {
  #buffer = Buffer.alloc(0)

  /** Feed bytes; returns every complete PNG that ended inside them. */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames = []
    for (;;) {
      const start = this.#buffer.indexOf(PNG_SIGNATURE)
      if (start < 0) {
        if (this.#buffer.length > MAX_UNSYNCED_BYTES) {
          this.#buffer = this.#buffer.subarray(this.#buffer.length - PNG_SIGNATURE.length)
        }
        return frames
      }
      if (start > 0) this.#buffer = this.#buffer.subarray(start)
      const end = this.#frameEnd()
      if (end === undefined) {
        if (this.#buffer.length > MAX_FRAME_BYTES) {
          this.#buffer = this.#buffer.subarray(1)
          continue
        }
        return frames
      }
      frames.push(this.#buffer.subarray(0, end))
      this.#buffer = this.#buffer.subarray(end)
    }
  }

  /** Byte length of the complete PNG at the buffer start, if fully buffered. */
  #frameEnd() {
    let offset = PNG_SIGNATURE.length
    for (;;) {
      if (offset + 8 > this.#buffer.length) return undefined
      const dataLength = this.#buffer.readUInt32BE(offset)
      const type = this.#buffer.readUInt32BE(offset + 4)
      if (dataLength > MAX_FRAME_BYTES) return undefined
      const next = offset + 8 + dataLength + 4
      if (next > this.#buffer.length) return undefined
      if (type === IEND_TYPE) return next
      offset = next
    }
  }
}

/**
 * Owns the one persistent screencap child for a device serial. Listeners are
 * cheap; the loop is started on demand and stopped when nobody needs frames.
 */
export class FrameLoop {
  #child
  #splitter = new PngFrameSplitter()
  #rawSplitter = new RawFrameSplitter()
  #raw = false
  #listeners = new Set()
  #latest
  #sequence = 0
  #stderr = []
  #stderrPartial = ''
  #times = []
  #stopped = false
  #generation = 0
  #waiters = []

  /**
   * @param {{ adb: string, serial: string, intervalMs?: number }} options
   *   `intervalMs` is the pause the device-side loop takes between captures;
   *   it is the frame-rate cap (0 = capture as fast as the device can).
   */
  constructor(options) {
    this.adb = options.adb
    this.serial = options.serial
    this.intervalMs = options.intervalMs ?? 120
    this.#raw = options.raw === true
  }

  get running() {
    const child = this.#child
    return child !== undefined && child.exitCode === null && child.signalCode === null
  }

  get latest() {
    return this.#latest
  }

  /** Whether the newest raw frame is entirely black (raw mode only). */
  get latestIsBlack() {
    return this.#raw ? this.#rawSplitter.lastFrameBlack : null
  }

  get stderrLines() {
    return [...this.#stderr]
  }

  /** Subscribe to frames; returns the unsubscribe function. */
  addListener(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  start() {
    if (this.running || this.#stopped) return
    const sleepSeconds = this.intervalMs > 0 ? this.intervalMs / 1000 : 0
    const command = this.#raw
      ? (sleepSeconds > 0
          ? `while :; do screencap; sleep ${sleepSeconds.toFixed(2)}; done`
          : 'while :; do screencap; done')
      : (sleepSeconds > 0
          ? `while :; do screencap -p; sleep ${sleepSeconds.toFixed(2)}; done`
          : 'while :; do screencap -p; done')
    const generation = this.#generation
    this.#child = spawn(this.adb, ['-s', this.serial, 'exec-out', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const child = this.#child
    child.stdout?.on('data', (chunk) => {
      if (generation !== this.#generation) return
      const splitter = this.#raw ? this.#rawSplitter : this.#splitter
      for (const png of splitter.push(chunk)) this.#acceptFrame(png)
    })
    child.stderr?.on('data', (chunk) => this.#recordStderr(chunk))
    child.once('error', (error) => this.#recordStderr(`spawn error: ${error instanceof Error ? error.message : String(error)}`))
    child.once('close', () => {
      if (this.#child !== child) return
      this.#child = undefined
    })
  }

  /** Stop the child; the loop can be started again with `reset()`. */
  stop() {
    this.#stopped = true
    this.#generation += 1
    const child = this.#child
    this.#child = undefined
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const hardKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2000)
      hardKill.unref?.()
    }
    this.#settleWaiters()
  }

  /** Allow a stopped loop to be started again. */
  reset() {
    this.#stopped = false
    this.#splitter = new PngFrameSplitter()
    this.#rawSplitter = new RawFrameSplitter()
    this.#latest = undefined
    this.#sequence = 0
    this.#times = []
  }

  /** Frames per second measured over the last 3 seconds. */
  get fps() {
    const cutoff = Date.now() - 3000
    while (this.#times.length > 0 && this.#times[0] < cutoff) this.#times.shift()
    if (this.#times.length <= 1) return 0
    const span = Math.max(1, this.#times[this.#times.length - 1] - this.#times[0])
    return Math.round(((this.#times.length - 1) / span) * 10000) / 10
  }

  /** Resolve with the next frame, or the cached one when available. */
  waitForFrame(timeoutMs) {
    if (this.#latest !== undefined) return Promise.resolve(this.#latest)
    return new Promise((resolve) => {
      let settled = false
      const waiter = (frame) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(frame)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.#waiters = this.#waiters.filter((entry) => entry !== waiter)
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      this.#waiters.push(waiter)
    })
  }

  #settleWaiters() {
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) waiter(this.#latest)
  }

  #acceptFrame(png) {
    const size = pngDimensions(png)
    if (size === undefined) return
    this.#sequence += 1
    const now = Date.now()
    const frame = { png, width: size.width, height: size.height, sequence: this.#sequence, at: now }
    this.#latest = frame
    this.#times.push(now)
    if (this.#times.length > 240) this.#times.splice(0, this.#times.length - 240)
    for (const listener of [...this.#listeners]) {
      try {
        listener(frame)
      } catch {
        // A subscriber's failure must never stop the frame loop.
      }
    }
    this.#settleWaiters()
  }

  #recordStderr(chunk) {
    const text = this.#stderrPartial + chunk.toString('utf8')
    const lines = text.split('\n')
    this.#stderrPartial = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (trimmed === '') continue
      this.#stderr.push(trimmed.length > STDERR_LINE_MAX ? `${trimmed.slice(0, STDERR_LINE_MAX)}...` : trimmed)
      if (this.#stderr.length > 20) this.#stderr.shift()
    }
  }
}

/** Writes one live `multipart/x-mixed-replace` PNG response. */
export class MultipartWriter {
  #closed = false
  #congested = false

  constructor(res) {
    this.res = res
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
      'cache-control': 'no-cache, no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    })
    res.on('drain', () => {
      this.#congested = false
    })
  }

  get closed() {
    return this.#closed
  }

  writeFrame(frame) {
    if (this.#closed || this.#congested || frame === undefined) return
    const header = `--${STREAM_BOUNDARY}\r\n`
      + 'Content-Type: image/png\r\n'
      + `Content-Length: ${frame.png.length}\r\n\r\n`
    try {
      this.res.write(header)
      const flushed = this.res.write(frame.png)
      this.res.write('\r\n')
      if (!flushed) this.#congested = true
    } catch {
      this.close()
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.res.end()
    } catch {
      // The socket may already be gone.
    }
  }
}
