/**
 * Host half of the interactive-browser bundle.
 *
 * Owns a real Chromium on a virtual display and exposes it to the Web page as a
 * same-origin surface:
 *
 *   Xvfb :99 -> Chromium (persistent profile) -> x11vnc 127.0.0.1:5900
 *                                                   -> websockify 127.0.0.1:6080
 *                                                        -> /ibrowser/* (this plugin)
 *
 * Serving it through `ctx.webServer` instead of pointing an iframe at :6080
 * fixes two separate problems: an HTTPS page cannot frame an HTTP origin, and
 * `192.168.x.x:6080` is unreachable from a remote browser.
 *
 * Authentication has exactly one lock, the Harness session on `/ibrowser/*`.
 * Both ends of the chain stay on loopback and x11vnc runs without a VNC
 * password, because a second prompt on the same door is friction, not security.
 */

import { spawn, execFile } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { request as httpRequest } from 'node:http'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable Loader identity. */
export const name = 'interactive-browser'

/** Services this plugin registers into. */
export const inject = ['tools']

/** Route prefix this plugin owns on the Web server. */
const PREFIX = '/ibrowser'

/** Defaults; every field is overridable through the bundle row's `config`. */
const DEFAULTS = {
  display: ':99',
  screen: '1440x900x24',
  vncPort: 5900,
  webPort: 6080,
  startUrl: 'https://example.com',
  xvfbBin: 'Xvfb',
  x11vncBin: 'x11vnc',
  websockifyBin: 'websockify',
  scrotBin: 'scrot',
  novncWeb: '/usr/share/novnc',
  /** Extra Playwright package directories to try before the built-in search. */
  playwrightPaths: [],
}

const STRING_KEYS = [
  'display', 'screen', 'startUrl', 'xvfbBin', 'x11vncBin', 'websockifyBin', 'scrotBin', 'novncWeb',
]
const NUMBER_KEYS = ['vncPort', 'webPort']

/**
 * Merge and validate the row config.
 * @param config - raw config from the Loader row.
 * @returns validated settings.
 */
function resolveSettings(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  for (const key of STRING_KEYS) {
    if (typeof merged[key] !== 'string' || merged[key] === '') {
      throw new Error(`interactive-browser: config.${key} must be a non-empty string`)
    }
  }
  for (const key of NUMBER_KEYS) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1 || merged[key] > 65_535) {
      throw new Error(`interactive-browser: config.${key} must be an integer port`)
    }
  }
  if (merged.vncPort === merged.webPort) {
    throw new Error('interactive-browser: config.vncPort and config.webPort must differ')
  }
  if (!Array.isArray(merged.playwrightPaths)) {
    throw new Error('interactive-browser: config.playwrightPaths must be an array of paths')
  }
  return merged
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether something already listens on a loopback port.
 *
 * Pid files alone are not enough: a plugin reload, a second Harness process or
 * a leftover child can own the port while our file points nowhere. Probing the
 * socket is the only reliable idempotence check.
 * @param port - TCP port on 127.0.0.1.
 */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * pnpm stores that may hold playwright, derived from the Harness entry point.
 *
 * The spawned browser runner knows nothing about the Harness install, so this
 * is resolved in-process and baked into the generated file.
 */
function storeRoots() {
  const roots = []
  const argv1 = process.argv[1]
  if (!argv1) return roots
  try {
    let dir = dirname(realpathSync(argv1))
    for (let i = 0; i < 5; i += 1) {
      roots.push(join(dir, 'node_modules', '.pnpm'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* argv[1] may be a bare name rather than a path */
  }
  return roots
}

/**
 * Everything below is closure state, so two rows with different ports or
 * displays do not overwrite each other's files.
 * @param settings - validated settings.
 */
function createRuntime(settings) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(home, 'interactive-browser')
  const stateDir = join(root, 'state')
  const profileDir = join(root, 'profile')
  const shotDir = join(root, 'shots')
  const urlFile = join(stateDir, 'url.txt')
  const readyFile = join(stateDir, 'browser.ready')
  const runnerFile = join(root, 'browser.mjs')

  /** One in-flight start at a time: concurrent /api/start calls must not double-spawn. */
  let starting

  const pidFile = (key) => join(stateDir, `${key}.pid`)
  const logFile = (key) => join(stateDir, `${key}.log`)

  function readPid(key) {
    const file = pidFile(key)
    if (!existsSync(file)) return undefined
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 1 ? pid : undefined
  }

  function alive(pid) {
    if (pid === undefined) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const running = (key) => alive(readPid(key))

  /** Tail of a layer's log, for diagnosing a stack that refused to come up. */
  function logTail(key, lines = 4) {
    const file = logFile(key)
    if (!existsSync(file)) return ''
    try {
      return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  /** Detached spawn so the display stack outlives a plugin reload. */
  function launch(key, command, args, extraEnv = {}) {
    mkdirSync(stateDir, { recursive: true })
    const fd = openSync(logFile(key), 'a')
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ...extraEnv },
      })
      child.unref()
      writeFileSync(pidFile(key), String(child.pid))
      return child.pid
    } finally {
      // The child holds its own duplicate; the parent must release this one.
      closeSync(fd)
    }
  }

  function readUrl() {
    if (!existsSync(urlFile)) return settings.startUrl
    const value = readFileSync(urlFile, 'utf8').trim()
    return value || settings.startUrl
  }

  /**
   * Write the Playwright runner next to the state directory.
   *
   * Regenerated on every start rather than shipped, because it resolves
   * Playwright from wherever this deployment installed it.
   */
  function writeRunner() {
    const candidateList = JSON.stringify(settings.playwrightPaths)
    const body = `import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIGURED = ${candidateList}
const BAKED_STORES = ${JSON.stringify(storeRoots())}
const PROFILE = ${JSON.stringify(profileDir)}
const READY = ${JSON.stringify(readyFile)}
const START_URL = ${JSON.stringify(readUrl())}

const here = createRequire(import.meta.url)

/** Directories that may hold a pnpm virtual store next to a Harness install. */
function storeRoots() {
  const roots = BAKED_STORES.slice()
  const argv1 = process.argv[1]
  if (argv1) {
    let dir = dirname(argv1)
    for (let i = 0; i < 4; i += 1) {
      roots.push(join(dir, 'node_modules', '.pnpm'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return roots
}

/** Resolve the playwright package without assuming one install layout. */
function resolvePlaywright() {
  const direct = [process.env.IBROWSER_PLAYWRIGHT, ...CONFIGURED, 'playwright'].filter(Boolean)
  for (const spec of direct) {
    try {
      const pw = spec === 'playwright' ? here('playwright') : here(join(spec, 'index.js'))
      if (pw?.chromium?.launchPersistentContext) return pw
    } catch {}
  }

  // Last resort: scan a pnpm store for the newest playwright@ entry.
  for (const base of storeRoots()) {
    let entries = []
    try {
      entries = readdirSync(base).filter((entry) => entry.startsWith('playwright@')).sort().reverse()
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(base, entry, 'node_modules', 'playwright')
      if (!existsSync(dir)) continue
      try {
        const pw = here(join(dir, 'index.js'))
        if (pw?.chromium?.launchPersistentContext) return pw
      } catch {}
    }
  }
  const tried = storeRoots().join(', ')
  throw new Error('playwright not found. Set IBROWSER_PLAYWRIGHT to its package directory. Searched: '
    + (CONFIGURED.join(', ') || 'no configured paths') + ' | ' + tried)
}

mkdirSync(PROFILE, { recursive: true })
const { chromium } = resolvePlaywright()
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  args: ['--window-position=0,0', '--window-size=1440,880', '--no-first-run',
         '--no-default-browser-check', '--disable-features=Translate'],
  locale: 'zh-CN',
})
const page = context.pages()[0] ?? await context.newPage()
await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})
writeFileSync(READY, String(Date.now()))
await new Promise(() => {})
`
    writeFileSync(runnerFile, body)
  }

  async function startXvfb() {
    if (running('xvfb')) return
    launch('xvfb', settings.xvfbBin, [settings.display, '-screen', '0', settings.screen, '-nolisten', 'tcp'])
    await delay(1200)
  }

  async function startBrowser() {
    if (running('browser')) return
    // A ready marker from a previous run would make the poll below pass instantly.
    rmSync(readyFile, { force: true })
    writeRunner()
    launch('browser', process.execPath, [runnerFile], { DISPLAY: settings.display })
    for (let i = 0; i < 60; i++) {
      await delay(500)
      if (!running('browser')) break
      if (existsSync(readyFile)) return
    }
    throw new Error(`browser did not become ready: ${logTail('browser') || 'no log output'}`)
  }

  async function startVnc() {
    if (running('x11vnc') || await portOpen(settings.vncPort)) return
    launch('x11vnc', settings.x11vncBin, [
      '-display', settings.display,
      '-nopw',
      '-rfbport', String(settings.vncPort),
      '-localhost', '-forever', '-shared', '-noxdamage',
    ])
    await delay(800)
    if (!await portOpen(settings.vncPort)) {
      throw new Error(`x11vnc did not listen on ${settings.vncPort}: ${logTail('x11vnc')}`)
    }
  }

  async function startWebsockify() {
    if (running('websockify') || await portOpen(settings.webPort)) return
    launch('websockify', settings.websockifyBin, [
      '--web', settings.novncWeb,
      `127.0.0.1:${settings.webPort}`,
      `127.0.0.1:${settings.vncPort}`,
    ])
    await delay(1200)
    if (!await portOpen(settings.webPort)) {
      throw new Error(`websockify did not listen on ${settings.webPort}: ${logTail('websockify')}`)
    }
  }

  /** Start every layer once, collapsing concurrent callers onto one attempt. */
  function ensureStack() {
    if (starting) return starting
    starting = (async () => {
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(profileDir, { recursive: true })
      mkdirSync(shotDir, { recursive: true })
      await startXvfb()
      await startBrowser()
      await startVnc()
      await startWebsockify()
    })().finally(() => {
      starting = undefined
    })
    return starting
  }

  function stopStack() {
    const stopped = []
    for (const key of ['websockify', 'x11vnc', 'browser', 'xvfb']) {
      const pid = readPid(key)
      if (pid === undefined) continue
      try {
        process.kill(pid, 'SIGTERM')
        stopped.push(key)
      } catch {
        /* already gone */
      }
      rmSync(pidFile(key), { force: true })
    }
    rmSync(readyFile, { force: true })
    return stopped
  }

  /** Snapshot the virtual display so the agent can see what the user sees. */
  function screenshot() {
    mkdirSync(shotDir, { recursive: true })
    const file = join(shotDir, `shot-${Date.now()}.png`)
    return new Promise((resolve, reject) => {
      execFile(settings.scrotBin, ['-o', file], { env: { ...process.env, DISPLAY: settings.display } },
        (error) => (error ? reject(error) : resolve(file)))
    })
  }

  async function status() {
    const vnc = await portOpen(settings.vncPort)
    const web = await portOpen(settings.webPort)
    const browser = running('browser')
    return {
      running: browser && vnc && web,
      layers: { xvfb: running('xvfb'), browser, x11vnc: vnc, websockify: web },
      display: settings.display,
      url: readUrl(),
      profile: profileDir,
      panelPath: `${PREFIX}/vnc.html?autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000&path=websockify`,
    }
  }

  function setUrl(url) {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(urlFile, url)
  }

  return { ensureStack, stopStack, status, screenshot, readUrl, setUrl }
}

/* ------------------------------------------------------------ web carrier */

function stripPrefix(url) {
  const suffix = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url
  return suffix === '' ? '/' : suffix
}

function json(res, value, code = 200) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * Proxy one HTTP request to websockify, which serves the noVNC assets.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param webPort - websockify port on loopback.
 */
function proxyHttp(req, res, webPort) {
  const path = stripPrefix(req.url ?? '/')
  if (path.includes('..')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: webPort,
      method: req.method,
      path,
      headers: { ...req.headers, host: `127.0.0.1:${webPort}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (res.headersSent) return
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('interactive browser is not running')
  })
  req.pipe(upstream)
}

/**
 * Raw TCP pipe of an HTTP upgrade to websockify, which owns the RFB framing.
 * @param req - upgrade request.
 * @param socket - client socket.
 * @param head - already-read bytes after the headers.
 * @param webPort - websockify port on loopback.
 */
function proxyUpgrade(req, socket, head, webPort) {
  const upstream = netConnect({ host: '127.0.0.1', port: webPort }, () => {
    const lines = ['GET /websockify HTTP/1.1']
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i]
      // The upstream socket is loopback; keep the Host and Origin it expects.
      if (/^host$/i.test(key)) continue
      lines.push(`${key}: ${req.rawHeaders[i + 1]}`)
    }
    lines.push(`Host: 127.0.0.1:${webPort}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head && head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

/**
 * Register the panel route, its status API and the websocket bridge.
 * @param ctx - plugin context.
 * @param runtime - this row's runtime.
 * @param settings - validated settings.
 */
function registerRoutes(ctx, runtime, settings) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      auth: 'required',
      async handler(req, res) {
        const path = stripPrefix(req.url ?? '/')
        if (path === '/api/state') return json(res, await runtime.status())

        // Mutations must be POST: a cross-site GET (top-level navigation, image
        // probe) could otherwise start or stop the stack on the user's behalf.
        if (path === '/api/start' || path === '/api/stop') {
          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST')
            return json(res, { error: 'method not allowed' }, 405)
          }
          if (path === '/api/start') {
            try {
              await runtime.ensureStack()
              return json(res, await runtime.status())
            } catch (error) {
              return json(res, { error: String(error?.message ?? error) }, 500)
            }
          }
          return json(res, { stopped: runtime.stopStack() })
        }
        return proxyHttp(req, res, settings.webPort)
      },
    }), 'interactive-browser: panel route')

    scoped.effect(() => scoped.webServer.registerUpgrade({
      path: `${PREFIX}/websockify`,
      auth: 'required',
      handler: (req, socket, head) => proxyUpgrade(req, socket, head, settings.webPort),
    }), 'interactive-browser: vnc websocket')
  })
}

/* -------------------------------------------------------------- the tools */

/**
 * Build the single agent-facing tool for this runtime.
 * @param runtime - this row's runtime.
 */
function toolDefinition(runtime) {
  return {
    name: 'interactive_browser',
    description:
      'Drive the interactive browser panel in the right sidebar: a real Chromium on a virtual display '
      + 'that the user can see and type into through the Web page. Use it when a task needs a human to '
      + 'sign in (password, SMS code, QR scan), or when you want a live page beside the conversation. '
      + 'Actions: open (start the stack, optionally at a URL), status, screenshot (capture what the panel '
      + 'currently shows and return the PNG path), close (stop the whole stack).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'open | status | screenshot | close',
      },
      url: {
        type: 'string',
        description: 'HTTP(S) address to load on open. Ignored unless the stack was stopped.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          running: { type: 'boolean' },
          panelPath: { type: 'string' },
          screenshot: { type: 'string' },
          note: { type: 'string' },
        },
      },
      /** Model-facing text; the panel itself is the user-facing surface. */
      render: (_args, value) => {
        const lines = []
        if (typeof value?.running === 'boolean') lines.push(`running: ${value.running}`)
        for (const [key, layer] of Object.entries(value?.layers ?? {})) lines.push(`${key}: ${layer}`)
        if (value?.screenshot) lines.push(`screenshot: ${value.screenshot}`)
        if (value?.note) lines.push(String(value.note))
        return [{ type: 'text', text: lines.join('\n') || JSON.stringify(value) }]
      },
    },
    async execute(args) {
      const action = String(args?.action ?? 'status')
      if (action === 'open') {
        const url = typeof args?.url === 'string' ? args.url.trim() : ''
        if (url) {
          const parsed = new URL(url)
          if (!/^https?:$/.test(parsed.protocol)) throw new Error('url must be http(s)')
          runtime.setUrl(url)
        }
        await runtime.ensureStack()
        const state = await runtime.status()
        return {
          ...state,
          note: state.running
            ? 'The panel is live. The user can type in it directly; the page inside is a real browser.'
            : 'Stack did not come up; check the logs under the state directory.',
        }
      }
      if (action === 'close') {
        return { running: false, note: `stopped: ${runtime.stopStack().join(', ') || 'nothing'}` }
      }
      if (action === 'screenshot') {
        const state = await runtime.status()
        if (!state.layers.xvfb) return { running: false, note: 'nothing to capture; open the panel first' }
        const file = await runtime.screenshot()
        return { running: true, screenshot: file, note: 'PNG of the virtual display at this moment.' }
      }
      return runtime.status()
    },
  }
}

/**
 * @param ctx - plugin context.
 * @param config - the row's config; every field of {@link DEFAULTS} is optional.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const runtime = createRuntime(settings)
  ctx.effect(() => ctx.tools.register(toolDefinition(runtime)), 'interactive-browser: tool')
  registerRoutes(ctx, runtime, settings)
}
