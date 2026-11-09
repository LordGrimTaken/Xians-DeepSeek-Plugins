// Tests for the PNG frame pipeline. Run: node --test test/frame.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { PngFrameSplitter, pngDimensions, PNG_SIGNATURE, MultipartWriter, rawScreencapToPng, RawFrameSplitter, rawFrameIsBlack } from '../host/frame.js'

/** Build one minimal but structurally valid PNG (enough for the splitter). */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4) // the splitter does not verify CRCs
  return Buffer.concat([length, body, crc])
}

function fakePng(width, height, idat = 64) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.alloc(idat, 0x42)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('pngDimensions reads IHDR without decoding', () => {
  const png = fakePng(720, 1280)
  assert.deepEqual(pngDimensions(png), { width: 720, height: 1280 })
  assert.equal(pngDimensions(PNG_SIGNATURE), undefined)
  assert.equal(pngDimensions(Buffer.from('not a png')), undefined)
})

test('splitter cuts concatenated frames exactly', () => {
  const a = fakePng(720, 1280)
  const b = fakePng(1280, 720, 100)
  const splitter = new PngFrameSplitter()
  const frames = splitter.push(Buffer.concat([a, b]))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].length, a.length)
  assert.equal(frames[1].length, b.length)
  assert.deepEqual(pngDimensions(frames[1]), { width: 1280, height: 720 })
})

test('splitter is incremental across arbitrary chunk boundaries', () => {
  const a = fakePng(720, 1280)
  const b = fakePng(720, 1280, 128)
  const all = Buffer.concat([a, b])
  const splitter = new PngFrameSplitter()
  const frames = []
  for (let index = 0; index < all.length; index += 7) {
    frames.push(...splitter.push(all.subarray(index, Math.min(all.length, index + 7))))
  }
  assert.equal(frames.length, 2)
  assert.equal(frames[0].length, a.length)
  assert.equal(frames[1].length, b.length)
})

test('splitter resyncs after garbage instead of stalling', () => {
  const a = fakePng(720, 1280)
  const splitter = new PngFrameSplitter()
  const frames = splitter.push(Buffer.concat([Buffer.from('noise-noise'), a]))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].length, a.length)
})

test('multipart writer emits rfc-style parts and skips frames while congested', () => {
  const writes = []
  let ended = false
  let drain = null
  let congestNextPng = false
  const png = fakePng(720, 1280)
  const res = {
    writeHead(status, headers) {
      writes.push({ status, headers })
    },
    write(data) {
      writes.push({ data })
      if (Buffer.isBuffer(data) && congestNextPng) {
        congestNextPng = false
        return false
      }
      return true
    },
    end() {
      ended = true
    },
    on(event, handler) {
      if (event === 'drain') drain = handler
    },
  }
  const writer = new MultipartWriter(res)
  writer.writeFrame({ png, width: 720, height: 1280 })
  assert.equal(writes[0].status, 200)
  assert.match(writes[0].headers['content-type'], /^multipart\/x-mixed-replace; boundary=/)
  const header = writes.find((entry) => typeof entry.data === 'string')
  assert.match(header.data, /Content-Type: image\/png/)
  assert.match(header.data, new RegExp(`Content-Length: ${png.length}`))

  // A saturated socket drops the frame instead of queueing it.
  congestNextPng = true
  writer.writeFrame({ png, width: 720, height: 1280 })
  const before = writes.length
  writer.writeFrame({ png, width: 720, height: 1280 })
  assert.equal(writes.length, before)

  // After drain the next frame flows again.
  drain()
  writer.writeFrame({ png, width: 720, height: 1280 })
  assert.ok(writes.length > before)
  writer.close()
  assert.equal(ended, true)
})

/** Build one raw screencap frame with the 16-byte Android header. */
function rawScreencapFrame(width, height) {
  const header = Buffer.alloc(16)
  header.writeUInt32LE(width, 0)
  header.writeUInt32LE(height, 4)
  header.writeUInt32LE(1, 8) // RGBA_8888
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0x20
    pixels[i + 1] = 0x80
    pixels[i + 2] = 0x40
    pixels[i + 3] = 0xff
  }
  return Buffer.concat([header, pixels])
}

test('rawScreencapToPng converts a raw RGBA frame and preserves dimensions', () => {
  const png = rawScreencapToPng(rawScreencapFrame(540, 960))
  assert.deepEqual(pngDimensions(png), { width: 540, height: 960 })
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE))
})

test('RawFrameSplitter emits back-to-back raw frames as PNGs', () => {
  const one = rawScreencapFrame(320, 480)
  const two = rawScreencapFrame(720, 1280)
  const splitter = new RawFrameSplitter()
  const stream = Buffer.concat([one, two])
  assert.equal(splitter.push(stream.subarray(0, 100)).length, 0)
  const frames = splitter.push(stream.subarray(100))
  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map((frame) => pngDimensions(frame)), [
    { width: 320, height: 480 },
    { width: 720, height: 1280 },
  ])
})

test('rawFrameIsBlack distinguishes a black screen from rendered pixels', () => {
  const black = rawScreencapFrame(64, 64)
  for (let i = 16; i < black.length; i += 4) { black[i] = 0; black[i + 1] = 0; black[i + 2] = 0 }
  assert.equal(rawFrameIsBlack(black), true)
  const rendered = rawScreencapFrame(64, 64)
  rendered[16] = 0x20
  assert.equal(rawFrameIsBlack(rendered), false)
  const splitter = new RawFrameSplitter()
  splitter.push(black)
  assert.equal(splitter.lastFrameBlack, true)
  splitter.push(rendered)
  assert.equal(splitter.lastFrameBlack, false)
})
