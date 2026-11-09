/**
 * Browser control - a headless Chromium the agent can drive against the
 * authenticated local DSH Web UI (or another loopback page).
 *
 * The Harness host hands out an authenticated URL through ctx.connection; this
 * plugin launches its own headless Chromium with a temporary profile (never the
 * user's browser profile) and exposes a loopback, same-origin-fenced HTTP API:
 *
 *   GET  /probe              chromium/browser status
 *   POST /open               open the app (or a loopback URL), default 1600x1000
 *   GET  /screenshot         capture the viewport to a PNG, return its path
 *   GET  /dom?selector=      element summaries (text, aria, rect, style)
 *   POST /eval               run JavaScript in the page, return its JSON value
 *   POST /click              click by selector / visible text / aria-label
 *   POST /type               focus a selector (optional) and insert text
 *   POST /key                dispatch a named key
 *   POST /close              stop the headless browser
 *
 * Security: loopback peer + loopback Host only; POSTs also need a same-origin
 * Origin. Navigation is restricted to loopback URLs so this cannot become a
 * general proxy.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

export const inject = ['webServer']

export const ROUTE_PREFIX = '/_dsh/browser-control'

const MAX_BODY_BYTES = 256 * 1024
const MAX_CODE_CHARS = 200_000
const IDLE_CLOSE_MS = 15 * 60 * 1000
const execFileAsync = promisify(execFile)

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped)) return true
    const hex = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(mapped)
    return hex !== null && (Number.parseInt(hex[1], 16) >>> 8) === 127
  }
  return false
}

function parseAuthority(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return null
  try {
    const parsed = new URL(`http://${host}`)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
      || parsed.username !== '' || parsed.password !== '') return null
    return parsed
  } catch {
    return null
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

function isTrusted(req, requireOrigin) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const authority = parseAuthority(req)
  if (authority === null) return false
  if (!isLoopbackHostname(authority.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/'
      || parsed.search !== '' || parsed.hash !== '') return false
    return parsed.host === authority.host
  } catch {
    return false
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

async function readJsonBody(req) {
  const type = req.headers['content-type']
  if (typeof type !== 'string' || !/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new Error('expected application/json')
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const value = text.trim() === '' ? {} : JSON.parse(text)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  return value
}

function jsString(value) {
  return JSON.stringify(String(value))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 0
    this.pending = new Map()
    this.events = []
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = () => { cleanup(); reject(new Error('could not connect to the Chromium DevTools websocket')) }
      const cleanup = () => {
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
      }
      this.ws.addEventListener('open', onOpen, { once: true })
      this.ws.addEventListener('error', onError, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      let message = null
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message !== null && message.method !== undefined) {
        this.events.push(message)
        if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000)
        return
      }
      if (message === null || message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (pending.timer !== null) clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'CDP error'))
      else pending.resolve(message.result)
    })
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        if (pending.timer !== null) clearTimeout(pending.timer)
        pending.reject(new Error('Chromium DevTools connection closed'))
      }
      this.pending.clear()
    })
  }

  send(method, params = {}) {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chromium DevTools connection is not open'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws?.close() } catch { /* gone */ }
    this.ws = null
  }
}

export class BrowserControl {
  constructor(ctx) {
    this.ctx = ctx
    this.chromePath = null
    this.child = null
    this.cdp = null
    this.port = null
    this.profileDir = null
    this.viewport = { width: 1600, height: 1000 }
    this.idleTimer = null
    this.shotDir = path.join(tmpdir(), 'dsh-browser-control')
    this.lastUrl = null
  }

  appUrl() {
    const origin = this.ctx.webServer.getOrigin()
    const connection = this.ctx.get('connection')
    if (connection !== undefined && typeof connection.authenticatedUrl === 'function') {
      try { return connection.authenticatedUrl(origin) } catch { /* fall through */ }
    }
    return origin.endsWith('/') ? origin : origin + '/'
  }

  async findChrome() {
    if (this.chromePath !== null && existsSync(this.chromePath)) return this.chromePath
    const candidates = []
    if (process.env.DSH_BROWSER_CHROME) candidates.push(process.env.DSH_BROWSER_CHROME)
    // Prefer a full browser build (Chrome/Edge) for media codecs; the Playwright
    // headless shell is a fallback when no system browser is installed.
    const local = process.env.LOCALAPPDATA
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], local]) {
      if (typeof base !== 'string' || base === '') continue
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
    if (local) {
      const root = path.join(local, 'ms-playwright')
      try {
        const entries = await readdir(root, { withFileTypes: true })
        const shells = entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-'))
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
        for (const entry of shells) candidates.push(path.join(root, entry.name, 'chrome-win', 'headless_shell.exe'))
        const full = entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
        for (const entry of full) candidates.push(path.join(root, entry.name, 'chrome-win', 'chrome.exe'))
      } catch { /* no playwright cache */ }
    }
    const found = candidates.find((candidate) => typeof candidate === 'string' && existsSync(candidate))
    if (found === undefined) throw new Error('no Chromium/Chrome executable found (set DSH_BROWSER_CHROME)')
    this.chromePath = found
    return found
  }

  async ensure() {
    if (this.cdp !== null && this.child !== null && this.child.exitCode === null) return
    await this.close()
    const chromePath = await this.findChrome()
    this.profileDir = path.join(tmpdir(), `dsh-browser-control-profile-${process.pid}-${Date.now()}`)
    await mkdir(this.profileDir, { recursive: true })
    const headlessShell = /headless_shell\.exe$/i.test(chromePath)
    const args = [
      ...(headlessShell ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${this.viewport.width},${this.viewport.height}`,
      'about:blank',
    ]
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    const wsUrl = await new Promise((resolve, reject) => {
      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Chromium did not expose a DevTools endpoint in time'))
      }, 20_000)
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        buffer += chunk
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+)/.exec(buffer)
        if (match !== null) finish(null, { url: match[1], port: Number(match[2]) })
      })
      child.once('error', (error) => finish(error))
      child.once('exit', (code) => finish(new Error(`Chromium exited early (code ${String(code)})`)))
    })
    this.port = wsUrl.port
    const targetUrl = `http://127.0.0.1:${this.port}/json/new?about:blank`
    let target
    const response = await fetch(targetUrl, { method: 'PUT' })
    if (!response.ok) throw new Error(`could not create a Chromium page (${response.status})`)
    target = await response.json()
    this.cdp = new Cdp(target.webSocketDebuggerUrl)
    await this.cdp.connect()
    await this.cdp.send('Page.enable')
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Log.enable')
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    this.touchIdle()
  }

  async navigate(url) {
    const parsed = new URL(url)
    if (!isLoopbackHostname(parsed.hostname) && parsed.hostname !== 'localhost') {
      throw new Error('only loopback URLs can be opened by Browser control')
    }
    await this.ensure()
    await this.cdp.send('Page.navigate', { url })
    this.lastUrl = url
    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate('document.readyState')
        if (value === 'complete') { ready = true; break }
      } catch { /* navigation in progress */ }
      await sleep(200)
    }
    if (!ready) throw new Error('page did not finish loading')
    await sleep(300)
    this.touchIdle()
    return this.info()
  }

  async evaluate(code) {
    if (typeof code !== 'string' || code.trim() === '') throw new Error('code is required')
    if (code.length > MAX_CODE_CHARS) throw new Error('code is too large')
    await this.ensure()
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'JavaScript evaluation failed'
      throw new Error(description)
    }
    const value = result.result?.value
    this.touchIdle()
    return value === undefined ? null : value
  }

  async info() {
    if (this.cdp === null || this.child === null || this.child.exitCode !== null) {
      return { running: false, chromePath: this.chromePath, url: null, title: null, viewport: this.viewport }
    }
    let url = null
    let title = null
    try {
      url = await this.evaluate('location.href')
      title = await this.evaluate('document.title')
    } catch { /* page busy */ }
    return {
      running: true,
      chromePath: this.chromePath,
      pid: this.child.pid,
      port: this.port,
      url,
      title,
      viewport: this.viewport,
    }
  }

  async screenshot() {
    await this.ensure()
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const png = Buffer.from(result.data, 'base64')
    await mkdir(this.shotDir, { recursive: true })
    const file = path.join(this.shotDir, `shot-${Date.now()}.png`)
    await writeFile(file, png)
    this.touchIdle()
    return { path: file, format: 'png', width: this.viewport.width, height: this.viewport.height, bytes: png.length }
  }

  consoleEvents() {
    if (this.cdp === null) return []
    const entries = []
    for (const event of this.cdp.events) {
      if (event.method === 'Runtime.consoleAPICalled') {
        const params = event.params ?? {}
        entries.push({
          kind: 'console',
          level: params.type,
          text: (params.args ?? []).map((arg) => {
            if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
            return arg.description ?? arg.type ?? ''
          }).join(' '),
          url: params.stackTrace?.callFrames?.[0]?.url ?? null,
          line: params.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
          at: params.timestamp ?? null,
        })
      } else if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params?.exceptionDetails ?? {}
        entries.push({
          kind: 'exception',
          level: 'error',
          text: details.exception?.description ?? details.text ?? 'exception',
          url: details.url ?? details.stackTrace?.callFrames?.[0]?.url ?? null,
          line: details.lineNumber ?? null,
          at: details.timestamp ?? null,
        })
      } else if (event.method === 'Log.entryAdded') {
        const entry = event.params?.entry ?? {}
        entries.push({
          kind: 'log',
          level: entry.level,
          text: entry.text,
          url: entry.url ?? null,
          line: entry.lineNumber ?? null,
          at: entry.timestamp ?? null,
        })
      }
    }
    return entries.slice(-300)
  }

  async dom(selector) {    const code = `(() => {
      const selector = ${jsString(selector || 'body')};
      const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 200);
      return nodes.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className.slice(0, 200) : null,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          text: (el.innerText || el.textContent || '').trim().slice(0, 300),
          value: typeof el.value === 'string' ? el.value.slice(0, 200) : null,
          disabled: Boolean(el.disabled),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          display: style.display,
          visibility: style.visibility,
          color: style.color,
          background: style.backgroundColor,
          fontSize: style.fontSize,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      });
    })()`
    return this.evaluate(code)
  }

  async click(target) {
    if (!isRecord(target)) throw new Error('target is required')
    const selector = typeof target.selector === 'string' ? target.selector : ''
    const text = typeof target.text === 'string' ? target.text : ''
    const aria = typeof target.aria === 'string' ? target.aria : ''
    if (selector === '' && text === '' && aria === '') throw new Error('selector, text or aria is required')
    const code = `(() => {
      const selector = ${jsString(selector)};
      const wantedText = ${jsString(text)};
      const wantedAria = ${jsString(aria)};
      let el = null;
      if (selector !== '') el = document.querySelector(selector);
      if (el === null && wantedAria !== '') {
        el = Array.from(document.querySelectorAll('[aria-label]')).find((node) => node.getAttribute('aria-label') === wantedAria) || null;
      }
      if (el === null && wantedText !== '') {
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex], input'));
        el = candidates.find((node) => (node.innerText || node.value || '').trim().includes(wantedText)) || null;
      }
      if (el === null) return { found: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      el.click();
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').trim().slice(0, 200),
        ariaLabel: el.getAttribute('aria-label'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    })()`
    return this.evaluate(code)
  }

  async type(body) {
    const text = typeof body.text === 'string' ? body.text : ''
    const selector = typeof body.selector === 'string' ? body.selector : ''
    await this.ensure()
    if (selector !== '') {
      const focused = await this.evaluate(`(() => {
        const el = document.querySelector(${jsString(selector)});
        if (el === null) return false;
        el.focus();
        if (typeof el.select === 'function') el.select();
        return true;
      })()`)
      if (focused !== true) throw new Error(`selector not found: ${selector}`)
    }
    if (text !== '') await this.cdp.send('Input.insertText', { text })
    this.touchIdle()
    return { ok: true, typed: text.length, selector: selector || null }
  }

  async key(body) {
    const key = typeof body.key === 'string' ? body.key : ''
    if (key === '') throw new Error('key is required')
    await this.ensure()
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key })
    this.touchIdle()
    return { ok: true, key }
  }

  touchIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.close().catch(() => {})
    }, IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  async close() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.cdp !== null) {
      this.cdp.close()
      this.cdp = null
    }
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null && child.pid !== undefined) {
      try { await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* gone */ }
    } else if (child !== null) {
      try { child.kill() } catch { /* gone */ }
    }
    if (this.profileDir !== null) {
      const profile = this.profileDir
      this.profileDir = null
      await sleep(200)
      await rm(profile, { recursive: true, force: true }).catch(() => {})
    }
    this.port = null
    this.lastUrl = null
  }
}

export function mountRoutes(webServer, control) {
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      handle(req, res, control).catch((error) => {
        if (res.headersSent) {
          try { res.destroy() } catch { /* gone */ }
          return
        }
        sendJson(res, 503, { ok: false, error: errorMessage(error) })
      })
    },
  })
}

async function handle(req, res, control) {
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const requireOrigin = req.method === 'POST'
  if (!isTrusted(req, requireOrigin)) {
    sendJson(res, 403, { ok: false, error: 'loopback same-origin request required' })
    return
  }

  if (sub === '/probe' || sub === '/info') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
    sendJson(res, 200, { ok: true, browser: await control.info(), defaultUrl: control.appUrl() })
    return
  }

  if (sub === '/open') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const body = await readJsonBody(req)
    const target = typeof body.url === 'string' && body.url !== '' ? body.url : control.appUrl()
    sendJson(res, 200, { ok: true, page: await control.navigate(target) })
    return
  }

  if (sub === '/console') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
    sendJson(res, 200, { ok: true, entries: control.consoleEvents() })
    return
  }

  if (sub === '/screenshot') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
    sendJson(res, 200, { ok: true, ...(await control.screenshot()) })
    return
  }

  if (sub === '/dom') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
    sendJson(res, 200, { ok: true, elements: await control.dom(url.searchParams.get('selector') ?? 'body') })
    return
  }

  if (sub === '/eval') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, value: await control.evaluate(body.code) })
    return
  }

  if (sub === '/click') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, result: await control.click(body) })
    return
  }

  if (sub === '/type') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, result: await control.type(body) })
    return
  }

  if (sub === '/key') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, result: await control.key(body) })
    return
  }

  if (sub === '/close') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
    await control.close()
    sendJson(res, 200, { ok: true })
    return
  }

  sendJson(res, 404, { ok: false, error: `unknown Browser control route ${url.pathname}` })
}

export function apply(ctx) {
  const control = new BrowserControl(ctx)
  ctx.effect(() => {
    const dispose = mountRoutes(ctx.webServer, control)
    return () => {
      try { dispose() } catch { /* already gone */ }
      control.close().catch(() => {})
    }
  })
}
