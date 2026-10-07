/**
 * dsh-opening-splash - host half.
 *
 * A standard DSH bundle plugin. It does two things:
 *
 *   1. Registers the opening-animation assets on the web server:
 *        /dsh-opening/opening.js   the browser half (config prelude + loader)
 *        /dsh-opening/splash.html  the animation itself (self-contained)
 *        /dsh-opening/health.json  liveness/state probe, for diagnosis
 *
 *   2. Injects one <script> into the Web UI's index.html so the overlay is
 *      painted before the app renders. Both index channels are covered:
 *      the structured `webserver/index-inject` row (the only channel the
 *      Electron desktop shell reads) and the raw `tapIndex` transform used by
 *      browser deployments. Each side de-duplicates, so a host that uses both
 *      still injects one script.
 *
 * The row is registered at the very top of `apply()` on purpose: the desktop
 * shell collects the injection table once, at startup, so a row registered
 * after a service becomes available can miss that collection entirely.
 *
 * Pure ASCII, like the animation it ships. No runtime dependencies.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root: lib/index.js -> plugin root. Keeps the bundle relocatable. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')

const ROUTE_BASE = '/dsh-opening'
const OPENING_PATH = `${ROUTE_BASE}/opening.js`
const SPLASH_PATH = `${ROUTE_BASE}/splash.html`
const HEALTH_PATH = `${ROUTE_BASE}/health.json`
const PLAYED_PATH = `${ROUTE_BASE}/played`
const BOOT_SCRIPT_ID = 'dsh-opening-boot'

/** Runtime of the shipped animation: TOTAL(19000) + HOLD(900) + 350 ms tail. */
const ANIMATION_DURATION_MS = 20250

/**
 * Per-process observation of what the plugin actually did in a real browser.
 * This is the only honest way to answer "did the splash play in the GUI?"
 * without a browser of our own: the loader beacons back when it finishes, and
 * each route counts how many times it was served. Rebuilt on every load, so an
 * HMR reload restarts the observation window.
 */
const STATS = {
  since: new Date().toISOString(),
  served: { loader: 0, splash: 0, health: 0, played: 0 },
  lastPlayback: null,
  playbacks: 0,
  /* Every beacon, newest last: the parent's ending and the frame's own
     readiness both land here, which is what makes a silent channel visible. */
  events: [],
}
/* The beacon is unauthenticated, so a page could in principle spam it. Bound
   both the accepted rate and every recorded string: the worst case is one
   overwritten diagnostic record. */
const PLAYED_MIN_INTERVAL_MS = 500
const playedAcceptedAt = { bridge: 0, loader: 0 }

function noteServed(which) {
  STATS.served[which] += 1
}

const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch (err) {
    return '0.0.0'
  }
})()

/* ------------------------------- configuration ------------------------------ */

const DEFAULTS = Object.freeze({
  enabled: true,
  speed: 1,
  oncePerSession: false,
  cooldownMs: 0,
  skippable: true,
  skipOnAnyKey: false,
  /* A stray click during boot must not cut the opening short: the default is to
     play it in full, with Escape left as the deliberate way out. */
  skipOnClick: false,
  /* Off by default, so the opening is presented clean. */
  showSkipHint: false,
  fadeMs: 420,
  maxDurationMs: 0,
  loadTimeoutMs: 6000,
  debug: false,
})

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function pickNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Coerce any input into a complete, in-range config. Never throws. */
function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    enabled: pickBool(raw.enabled, DEFAULTS.enabled),
    speed: pickNumber(raw.speed, DEFAULTS.speed, 0.1, 8),
    oncePerSession: pickBool(raw.oncePerSession, DEFAULTS.oncePerSession),
    cooldownMs: pickNumber(raw.cooldownMs, DEFAULTS.cooldownMs, 0, 30 * 24 * 60 * 60 * 1000),
    skippable: pickBool(raw.skippable, DEFAULTS.skippable),
    skipOnAnyKey: pickBool(raw.skipOnAnyKey, DEFAULTS.skipOnAnyKey),
    skipOnClick: pickBool(raw.skipOnClick, DEFAULTS.skipOnClick),
    showSkipHint: pickBool(raw.showSkipHint, DEFAULTS.showSkipHint),
    fadeMs: pickNumber(raw.fadeMs, DEFAULTS.fadeMs, 0, 5000),
    maxDurationMs: pickNumber(raw.maxDurationMs, DEFAULTS.maxDurationMs, 0, 10 * 60 * 1000),
    loadTimeoutMs: pickNumber(raw.loadTimeoutMs, DEFAULTS.loadTimeoutMs, 500, 60000),
    debug: pickBool(raw.debug, DEFAULTS.debug),
  }
}

/**
 * The loader calls `Config['~standard'].validate(raw)` and falls back to the raw
 * value when a plugin declares no schema. Declaring a standard-schema shape here
 * keeps the plugin dependency-free while still getting validated, defaulted
 * config instead of whatever the YAML happened to say.
 */
const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-opening-splash',
    validate(input) {
      try {
        return { value: normalizeConfig(input) }
      } catch (err) {
        return { issues: [{ message: String((err && err.message) || err), path: [] }] }
      }
    },
  },
}

/* ---------------------------------- assets --------------------------------- */

/** mtime+size keyed cache: edits to an asset show up on the next page load. */
const assetCache = new Map()

function readAsset(name) {
  const file = path.join(ASSETS_DIR, name)
  try {
    const stat = fs.statSync(file)
    const hit = assetCache.get(file)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, body: fs.readFileSync(file) }
    assetCache.set(file, entry)
    return entry
  } catch (err) {
    return null
  }
}

/** What the browser half reads as `window.__DSH_OPENING__`. */
function clientConfig(config) {
  return {
    enabled: config.enabled,
    speed: config.speed,
    oncePerSession: config.oncePerSession,
    cooldownMs: config.cooldownMs,
    skippable: config.skippable,
    skipOnAnyKey: config.skipOnAnyKey,
    skipOnClick: config.skipOnClick,
    showSkipHint: config.showSkipHint,
    fadeMs: config.fadeMs,
    maxDurationMs: config.maxDurationMs,
    loadTimeoutMs: config.loadTimeoutMs,
    debug: config.debug,
    splashUrl: SPLASH_PATH,
    durationMs: ANIMATION_DURATION_MS,
  }
}

/* ---------------------------------- routes --------------------------------- */

/**
 * The loader beacons here when a splash ends, whatever the reason. This is what
 * turns "the plugin is loaded" into "the splash really ran, in this browser" --
 * the only evidence available when the host cannot run a browser of its own.
 *
 * It is a GET so the beacon can be an image or a keepalive fetch, and it records
 * nothing the client does not send. Every field is bounded and the accept rate
 * is limited, so the worst a hostile local page can do is overwrite a diagnostic.
 */
function makePlayedHandler() {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
    noteServed('played')
    const now = Date.now()
    let params = null
    try { params = new URL(req.url || PLAYED_PATH, 'http://dsh.invalid').searchParams } catch (err) { /* invalid URL */ }
    const bucket = params && params.get('stage') === 'bridge' ? 'bridge' : 'loader'
    if (now - playedAcceptedAt[bucket] >= PLAYED_MIN_INTERVAL_MS) {
      playedAcceptedAt[bucket] = now
      const read = (key, max) => {
        const value = params ? params.get(key) : null
        return typeof value === 'string' ? value.slice(0, max) : null
      }
      const size = (key) => {
        const n = Number(read(key, 8))
        return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n) : null
      }
      /* `stage=bridge` comes from inside the animation document; everything else
         is the parent loader reporting how a splash ended. Keeping them apart is
         what makes a silent channel diagnosable: a bridge event with no matching
         parent event means the message, not the bridge, is what failed. */
      const stage = read('stage', 16) || 'loader'
      const event = {
        at: new Date(now).toISOString(),
        stage,
        reason: read('reason', 48) || 'unknown',
        viewport: { width: size('w'), height: size('h') },
        via: read('via', 16),
        detail: read('detail', 48),
        userAgent: read('ua', 200),
      }
      STATS.events.push(event)
      if (STATS.events.length > 12) STATS.events.shift()
      if (stage !== 'bridge') {
        STATS.playbacks += 1
        STATS.lastPlayback = event
      }
    }
    respond(res, 204, { 'Cache-Control': 'no-store' }, undefined)
  }
}

function respond(res, status, headers, body) {
  try {
    res.writeHead(status, headers)
    if (body === undefined || body === null) res.end()
    else res.end(body)
  } catch (err) {
    try { res.destroy() } catch (ignored) { /* already gone */ }
  }
}

function methodNotAllowed(res, allow) {
  respond(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: allow }, 'method not allowed\n')
}

/** Escape `<` so a payload can never close the <script> element it sits in. */
function scriptLiteral(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function makeOpeningHandler(config) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
    noteServed('loader')
    const asset = readAsset('opening.js')
    if (!asset) {
      return respond(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' },
        'dsh-opening-splash: assets/opening.js is missing from the package\n')
    }
    const prelude = `window.__DSH_OPENING__=${scriptLiteral(clientConfig(config))};\n`
    const body = Buffer.concat([Buffer.from(prelude, 'utf8'), asset.body])
    respond(res, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': String(body.length),
      /* The config is baked into this response, so it must never be reused. */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    }, req.method === 'HEAD' ? undefined : body)
  }
}

/**
 * Bridge appended to the animation document as it is served.
 *
 * The splash runs in an iframe, and on the Electron shell that iframe is
 * cross-origin: the document is `dsh-app://app/` while the assets come from
 * `http://127.0.0.1:<port>`. Reading `iframe.contentWindow` across origins
 * throws, so the parent cannot observe the animation that way -- doing so is
 * what made an earlier build tear the overlay down mid-playback on a timer.
 *
 * `postMessage` crosses origins, so the animation announces its own readiness,
 * completion and skip intent instead. The parent generates a per-play token,
 * passes it in the splash URL, and accepts only messages echoing it: that
 * authenticates the sender by a secret rather than by WindowProxy identity,
 * which is not guaranteed to compare equal across origins.
 *
 * The bridge also beacons its own readiness straight to the host under
 * `stage=bridge`. That is deliberate: if a `ready` message ever goes missing,
 * the beacon still tells us the bridge ran, separating "the bridge never
 * executed" from "the message never arrived".
 *
 * This is appended at serve time on purpose: `assets/splash.html` stays a
 * byte-for-byte copy of the standalone deliverable.
 */
function bridgeScript(config) {
  const speed = config.speed
  const wireSkip = config.skippable
  const wireClick = config.skippable && config.skipOnClick
  /* Statement boundaries in this generated source are load-bearing: joining two
     calls with no separator (`say(..)post(..)`) is a SyntaxError that kills the
     whole script and, with it, every signal the parent has. Each fragment below
     therefore ends in `;` or `}`. `extractScripts()` in the checks parses this
     output for exactly that reason. */
  return '<script>'
    + '(function(){try{'
    /* The token travels in the query string of this document's own URL. */
    + 'var K="";'
    + 'try{K=new URLSearchParams(location.search).get("k")||""}catch(e){};'
    + 'window.addEventListener("message",function(e){var m=e.data;'
    + 'if(e.source!==parent||!K||!m||m.k!==K||m.source!=="dsh-opening-parent"||m.type!=="identity")return;'
    + 'window.__DSH_OPENING_IDENTITY__=typeof m.label==="string"?'
    + 'Array.from(m.label.replace(/[\\u0000-\\u001f\\u007f]/g," ")).slice(0,80).join(""):null;});'
    + 'function post(m){try{m.source="dsh-opening-splash";m.k=K;parent.postMessage(m,"*")}catch(e){}};'
    + 'function say(r){try{fetch("played?stage=bridge&reason="+encodeURIComponent(r)+'
    + '"&k="+encodeURIComponent(K),{cache:"no-store",keepalive:true}).catch(function(){})}catch(e){}};'
    /* Playback speed lives in the animation's module scope, which nothing
       outside can reach. It re-reads the global requestAnimationFrame every
       tick, so scaling the timestamps handed to the callback is equivalent. */
    + `var SPEED=${JSON.stringify(speed)};`
    + 'if(SPEED>0&&SPEED!==1&&typeof requestAnimationFrame==="function"){'
    + 'var raf=requestAnimationFrame,origin=performance.now();'
    + 'requestAnimationFrame=function(cb){return raf.call(window,function(){'
    + 'cb(origin+(performance.now()-origin)*SPEED)})}};'
    /* This script sits after the animation's own script, so it is already up. */
    + 'var d=null;'
    + 'try{d=window.DSHSplash&&Number(window.DSHSplash.duration)||null}catch(e){};'
    + 'say("bridge-ready");'
    + 'post({type:"ready",duration:d});'
    + 'try{window.addEventListener("dsh:splash-complete",function(e){'
    + 'var r=(e&&e.detail&&e.detail.reason)||"completed";'
    + 'say("bridge-done-"+r);'
    + 'post({type:"done",reason:r})})}catch(e){};'
    + 'try{window.addEventListener("keydown",function(e){'
    + 'if(!e)return;'
    + `var allowed=${JSON.stringify(wireSkip)}&&(e.key==="Escape"||e.key==="Esc"||${JSON.stringify(config.skipOnAnyKey)});`
    + 'if(e.key==="Escape"||e.key==="Esc"||allowed){e.preventDefault();e.stopImmediatePropagation();}'
    + 'if(allowed)post({type:"skip",how:"key"})},true)}catch(e){};'
    + (wireClick
      ? 'try{document.addEventListener("pointerdown",function(){post({type:"skip",how:"click"})},true)}catch(e){};'
      : '')
    + '}catch(e){}})()'
    + '</script>'
}

/** Splice the bridge in just before </body>, or append it when there is none. */
function withBridge(html, config) {
  /* Keep the archived animation byte-identical; personalize only its response.
     Names stay plain text, never HTML, URL parameters or diagnostic records. */
  html = html.replace("v: 'ID CONFIRMED : DEEPSEEK'",
    "get v() { return 'ID CONFIRMED : ' + (window.__DSH_OPENING_IDENTITY__ || 'DEEPSEEK'); }")
  html = html.replace('if (el.statusText.textContent !== msg) el.statusText.textContent = msg;',
    'if (el.statusText.textContent !== msg) { el.statusText.textContent = msg;'
    + 'el.statusText.style.display = "inline-block";'
    + 'el.statusText.style.textTransform = "none";'
    + 'el.statusText.style.transformOrigin = "left center";'
    + 'el.statusText.style.transform = "scaleX(1)";'
    + 'el.statusText.style.transform = "scaleX(" + Math.min(1, 850 / (el.statusText.offsetWidth || 1)) + ")"; }')
  const bridge = bridgeScript(config)
  const at = html.lastIndexOf('</body>')
  if (at === -1) return html + bridge
  return html.slice(0, at) + bridge + html.slice(at)
}

function makeSplashHandler(config) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
    noteServed('splash')
    const asset = readAsset('splash.html')
    if (!asset) {
      return respond(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' },
        'dsh-opening-splash: assets/splash.html is missing from the package\n')
    }
    const body = withBridge(asset.body.toString('utf8'), config)
    const out = Buffer.from(body, 'utf8')
    respond(res, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(out.length),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }, req.method === 'HEAD' ? undefined : out)
  }
}

function makeHealthHandler(config) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD')
    noteServed('health')
    const splash = readAsset('splash.html')
    const loader = readAsset('opening.js')
    const payload = {
      plugin: 'dsh-opening-splash',
      version: PACKAGE_VERSION,
      enabled: config.enabled,
      speed: config.speed,
      oncePerSession: config.oncePerSession,
      routes: { loader: OPENING_PATH, splash: SPLASH_PATH, played: PLAYED_PATH },
      assets: {
        'splash.html': splash ? splash.size : null,
        'opening.js': loader ? loader.size : null,
      },
      animationDurationMs: ANIMATION_DURATION_MS,
      /* Observation, not configuration: what happened in a real browser since
         this process loaded the plugin. */
      observed: {
        since: STATS.since,
        served: { ...STATS.served },
        playbacks: STATS.playbacks,
        lastPlayback: STATS.lastPlayback,
        events: STATS.events,
      },
    }
    const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    respond(res, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    }, req.method === 'HEAD' ? undefined : body)
  }
}

/* -------------------------------- injection -------------------------------- */

/**
 * Colors the canvas before the first paint and hides the app's own boot screen
 * while the splash is up, so the handoff has no flash and no double loading
 * screen. Scoped to the guard attribute below, which the loader removes when the
 * splash ends -- and which the boot script itself removes if the loader never
 * loads, so a broken install can never leave the app hidden.
 *
 * `[data-dsh-boot]` is the shell's boot panel (a div inside #root that paints
 * its own background); hiding it is what makes the swap seamless on the desktop
 * carrier, where rows arrive after that panel already exists.
 */
const BOOT_STYLE = 'html[data-dsh-opening-boot],'
  + 'html[data-dsh-opening-boot] body{background:#0b0b0b !important}'
  + 'html[data-dsh-opening-boot] [data-dsh-boot]{visibility:hidden !important}'

const BOOT_ATTRIBUTE = 'data-dsh-opening-boot'

/**
 * Inline row body: arm the boot style, then create the loader script element
 * and handle its failure.
 *
 * A `<script src>` row would be simpler, but the desktop shell's row interpreter
 * rejects the whole boot when such a row fails to load, so the element is built
 * here instead and its error is contained.
 *
 * The URL is origin-aware. In a browser the page origin is the host, so the
 * relative path is right. The Electron shell instead serves the document from
 * `dsh-app://app/`, where a relative path would resolve against the packaged
 * dist and 404 -- there the host origin comes from `__DSH_TRANSPORT__`, which the
 * shell sets before it applies any row. `go()` waits briefly for either to
 * become resolvable, then gives up and clears the boot style.
 */
function bootRowText() {
  return '(function(){try{'
    + 'var PATH=' + JSON.stringify(OPENING_PATH) + ';'
    + `var ID=${JSON.stringify(BOOT_SCRIPT_ID)};var ATTR=${JSON.stringify(BOOT_ATTRIBUTE)};`
    + 'var h=document.documentElement;if(h)h.setAttribute(ATTR,"");'
    + 'var tries=0;'
    /* "" = same origin; null = not determinable yet. */
    + 'function base(){'
    + 'try{if(location.protocol==="http:"||location.protocol==="https:")return ""}catch(e){}'
    + 'try{var t=globalThis.__DSH_TRANSPORT__;'
    + 'if(t&&typeof t.streamBaseUrl==="string"&&t.streamBaseUrl)'
    + 'return String(t.streamBaseUrl).replace(/\\/+$/,"")}catch(e){}'
    + 'return null}'
    + 'function clear(){try{if(h)h.removeAttribute(ATTR)}catch(e){}}'
    + 'function go(){'
    + 'var b=base();var d=document.body||document.head||document.documentElement;'
    + 'if(b===null||!d){if(tries++<12)setTimeout(go,120);else clear();return}'
    + 'try{window.__DSH_OPENING_BASE__=b}catch(e){}'
    + 'if(document.getElementById(ID))return;'
    + 'var s=document.createElement("script");s.id=ID;s.async=false;s.src=b+PATH;'
    + 's.onerror=function(){try{d.removeChild(s)}catch(e){}clear()};'
    + 'd.appendChild(s)}'
    + 'go()'
    + '}catch(e){}})()'
}

function injectionRows() {
  return [
    { kind: 'style', text: BOOT_STYLE },
    { kind: 'script', placement: 'head', text: bootRowText() },
  ]
}

/** Insert the same two pieces before anything else in <head>. */
function tapIndexHtml(html) {
  if (typeof html !== 'string' || html.indexOf(OPENING_PATH) !== -1) return html
  const tag = `<style>${BOOT_STYLE}</style><script>${bootRowText()}</script>`
  const open = /<head(?:\s[^>]*)?>/i.exec(html)
  if (open) {
    const at = open.index + open[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return tag + html
}

/* ---------------------------------- plugin --------------------------------- */

/**
 * @param root - the plugin's root context.
 * @param rawConfig - the entry's `config:` block, normalized below.
 */
function apply(root, rawConfig) {
  const config = normalizeConfig(rawConfig)

  /* (1) Desktop channel. Registered before anything is awaited: the Electron
     shell collects this table once during startup, so a late subscriber misses
     it and the splash silently never appears there. `prepend` puts these rows
     ahead of the app's own bootstrap rows, so on the desktop carrier -- which
     applies rows sequentially and awaits each `script-src` -- the overlay is
     raised before the shell waits on its bundles. */
  root.on('webserver/index-inject', (table) => {
    if (!config.enabled) return
    if (!Array.isArray(table)) return
    for (const row of table) {
      if (!row) continue
      if (row.kind === 'script-src' && row.src === OPENING_PATH) return
      if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(OPENING_PATH)) return
    }
    for (const row of injectionRows()) table.push(row)
  }, { prepend: true })

  /* (2) Browser channel: routes plus the raw tapIndex transform. */
  root.inject(['webServer'], (ctx) => {
    const disposers = []
    disposers.push(ctx.webServer.register({ kind: 'exact', path: OPENING_PATH, handler: makeOpeningHandler(config) }))
    disposers.push(ctx.webServer.register({ kind: 'exact', path: SPLASH_PATH, handler: makeSplashHandler(config) }))
    disposers.push(ctx.webServer.register({ kind: 'exact', path: HEALTH_PATH, handler: makeHealthHandler(config) }))
    disposers.push(ctx.webServer.register({ kind: 'exact', path: PLAYED_PATH, handler: makePlayedHandler() }))
    /* Only fires on hosts that do not render injection rows; when the row above
       is rendered the path is already in the document and this is a no-op. */
    if (config.enabled) disposers.push(ctx.webServer.tapIndex(tapIndexHtml))

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch (err) { /* a failed teardown must not block the rest */ }
      }
    })
  })
}

export { Config, apply, DEFAULTS, OPENING_PATH, SPLASH_PATH, HEALTH_PATH, PLAYED_PATH, normalizeConfig }
