// Executes the browser half for real against a minimal DOM shim. This is not a
// rendering test -- it cannot prove the animation looks right -- but it does
// execute every decision the loader makes: suppression, overlay construction,
// skip wiring, the load watchdog, the completion path and the cleanup.
//
// Run: node browser-half-check.mjs
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../assets/opening.js', import.meta.url), 'utf8')

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

/* ------------------------------- DOM shim -------------------------------- */

function makeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    _attrs: {},
    style: { cssText: '', opacity: '', pointerEvents: '', display: '' },
    children: [],
    parentNode: null,
    textContent: '',
    hidden: false,
    _listeners: {},
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) },
    removeAttribute(k) { delete this._attrs[k] },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.push(child)
      return child
    },
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      child.parentNode = null
      return child
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) {
      const list = this._listeners[type]
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    dispatch(type, event) { for (const fn of (this._listeners[type] || []).slice()) fn(event || {}) },
  }
}

function makeDocument() {
  const doc = {
    readyState: 'complete',
    documentElement: makeNode('html'),
    head: makeNode('head'),
    body: makeNode('body'),
    _listeners: {},
    createElement: (tag) => makeNode(tag),
    getElementById(id) {
      let found = null
      const walk = (n) => {
        if (found) return
        if (n.id === id) { found = n; return }
        for (const c of n.children) walk(c)
      }
      for (const root of [doc.documentElement, doc.head, doc.body]) walk(root)
      return found
    },
    addEventListener(type, fn) { (doc._listeners[type] ||= []).push(fn) },
  }
  doc.documentElement.appendChild(doc.head)
  doc.documentElement.appendChild(doc.body)
  return doc
}

/** Stand-in for the animation document inside the iframe. */
function makeFrameWindow() {
  const inner = makeDocument()
  const splash = makeNode('div')
  splash.id = 'splash'
  inner.body.appendChild(splash)
  const win = {
    document: inner,
    __splashReady: false,
    DSHSplash: null,
    finished: false,
    _listeners: {},
    addEventListener(type, fn) { (win._listeners[type] ||= []).push(fn) },
    removeEventListener() {},
    dispatch(type, event) { for (const fn of (win._listeners[type] || []).slice()) fn(event || {}) },
    performance: { now: () => Date.now() },
    requestAnimationFrame(cb) { return setTimeout(() => cb(Date.now()), 0) },
    cancelAnimationFrame(id) { clearTimeout(id) },
    /* What the real document does at the end of its inline script. */
    beReady() {
      win.__splashReady = true
      win.DSHSplash = Object.freeze({
        duration: 20250,
        skip() {
          win.finished = true
          splash.hidden = true
          splash.style.display = 'none'
          win.dispatch('dsh:splash-complete', { detail: { reason: 'skipped' } })
        },
        replay() {},
        renderAt() {},
      })
    },
    /* What the real document does when it finishes on its own. */
    complete() {
      win.finished = true
      splash.hidden = true
      splash.style.display = 'none'
      win.dispatch('dsh:splash-complete', { detail: { reason: 'completed' } })
    },
  }
  return win
}

/**
 * Models the Electron shell's cross-origin frame: the WindowProxy reference is
 * usable and compares by identity, but touching any property on it throws the
 * way a real cross-origin access does. The frame can only talk by postMessage.
 */
function makeBlockedWindow(deliver) {
  const sent = []
  const target = {
    /* What the host-appended bridge inside the animation posts. */
    post(data) { sent.push(data); if (deliver) deliver(data) },
    sent,
  }
  const proxy = new Proxy(target, {
    get(_t, prop) {
      /* Identity checks and the harness's own bookkeeping stay reachable; every
         real document read throws, exactly like the browser. */
      if (prop === 'post' || prop === 'sent') return target[prop]
      throw new DOMExceptionStub('Blocked a frame with origin "dsh-app://app" from accessing a cross-origin frame.')
    },
    has() { return true },
  })
  return proxy
}

class DOMExceptionStub extends Error {}

function makeStorage() {
  const map = new Map()
  return {    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

/** Run one fresh instance of the browser half, as the served prelude would.
 *  `crossOrigin` models the Electron shell: the frame document lives on another
 *  origin, so reading any property off `contentWindow` throws while the
 *  reference itself still compares equal -- the frame can only postMessage.
 *  `sharedSession` / `sharedLocal` reuse one storage area across runs, which is
 *  how a real reload behaves; `beforeFactory` runs before the loader does, so
 *  pre-set globals can be tested. */
function run({ config = {}, search = '', hash = '', origin = 'http:', crossOrigin = false, sharedSession, sharedLocal, beforeFactory } = {}) {
  const document = makeDocument()
  /* The proxy needs the parent window to deliver into, so it is built after. */
  let frameWindow = null
  const window = {
    __DSH_OPENING__: Object.assign({ splashUrl: '/dsh-opening/splash.html', durationMs: 20250 }, config),
    innerWidth: 1440,
    innerHeight: 810,
    _listeners: {},
    addEventListener(type, fn) { (window._listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) {
      const list = window._listeners[type]
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    dispatch(type, event) { for (const fn of (window._listeners[type] || []).slice()) fn(event || {}) },
    sessionStorage: sharedSession || makeStorage(),
    localStorage: sharedLocal || makeStorage(),
  }
  frameWindow = crossOrigin
    ? makeBlockedWindow((data) => window.dispatch('message', { source: frameWindow, data }))
    : makeFrameWindow()
  const location = { search, hash, protocol: origin }
  if (beforeFactory) beforeFactory(window)

  /* createElement('iframe') hands back a node whose contentWindow is the stub. */
  const realCreate = document.createElement.bind(document)
  document.createElement = (tag) => {
    const node = realCreate(tag)
    if (String(tag).toLowerCase() === 'iframe') node.contentWindow = frameWindow
    return node
  }

  const CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail } }
  const timers = { timeouts: [], intervals: [] }
  const setTimeoutShim = (fn, ms) => { const id = { fn, ms }; timers.timeouts.push(id); return id }
  const setIntervalShim = (fn, ms) => { const id = { fn, ms }; timers.intervals.push(id); return id }
  const clearShim = (id) => {
    for (const list of [timers.timeouts, timers.intervals]) {
      const i = list.indexOf(id)
      if (i >= 0) list.splice(i, 1)
    }
  }
  const fireTimeouts = (maxMs) => {
    for (const t of timers.timeouts.slice()) {
      if (maxMs === undefined || t.ms <= maxMs) { clearShim(t); t.fn() }
    }
  }

  const factory = new Function(
    'window', 'document', 'location', 'CustomEvent',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'console',
    'sessionStorage', 'localStorage', 'navigator', 'fetch', 'Image',
    `"use strict";\n${SRC}\n`,
  )
  const beacons = []
  const fetchStub = (url) => { beacons.push(String(url)); return Promise.resolve({ ok: true }) }
  factory(
    window, document, location, CustomEvent,
    setTimeoutShim, setIntervalShim, clearShim, clearShim, { log() {}, warn() {} },
    window.sessionStorage, window.localStorage,
    { userAgent: 'shim/1.0' }, fetchStub, class { constructor() { this.src = '' } },
  )

  return { window, document, frameWindow, timers, fireTimeouts, beacons }
}

const find = (doc, id) => doc.getElementById(id)
/* Drive a run to its natural end: ready -> load -> complete. */
function playThrough(r) {
  r.frameWindow.beReady()
  find(r.document, 'dsh-opening-frame').dispatch('load', {})
}

/** The token the loader put in the splash URL. */
function frameToken(r) {
  const fr = find(r.document, 'dsh-opening-frame')
  const src = fr.getAttribute('src') || fr.src || ''
  return new URL('http://x' + src).searchParams.get('k')
}

/** Deliver a message the way the host-appended bridge does. */
function frameMessage(r, data) {
  r.window.dispatch('message', {
    source: r.frameWindow,
    data: Object.assign({ source: 'dsh-opening-splash', k: frameToken(r) }, data),
  })
}

/* ------------------------------- the checks ------------------------------- */

console.log('suppression')
{
  const a = run({ config: { enabled: false } })
  check('enabled:false mounts no overlay', find(a.document, 'dsh-opening-overlay') === null)
  check('enabled:false leaves the boot style unarmed', !a.document.documentElement.hasAttribute('data-dsh-opening-boot'))
  check('enabled:false still loads the module', a.window.__DSH_OPENING_LOADED__ === true)

  const b = run({ search: '?noopening' })
  check('?noopening mounts no overlay', find(b.document, 'dsh-opening-overlay') === null)
  check('?noopening leaves the boot style unarmed', !b.document.documentElement.hasAttribute('data-dsh-opening-boot'))

  check('?noopening=1 also suppresses', find(run({ search: '?a=1&noopening=1' }).document, 'dsh-opening-overlay') === null)
  check('#noopening suppresses', find(run({ hash: '#noopening' }).document, 'dsh-opening-overlay') === null)
  check('an unrelated query does not suppress', find(run({ search: '?t=100' }).document, 'dsh-opening-overlay') !== null)

  const session = makeStorage()
  const local = makeStorage()
  const e = run({ config: { oncePerSession: true }, sharedSession: session, sharedLocal: local })
  check('oncePerSession plays on the first load', find(e.document, 'dsh-opening-overlay') !== null)
  playThrough(e)
  e.frameWindow.complete()
  check('oncePerSession recorded the completed play', session.getItem('dsh-opening:session') === '1')

  const again = run({ config: { oncePerSession: true }, sharedSession: session, sharedLocal: local })
  check('a reload in the same session is suppressed', find(again.document, 'dsh-opening-overlay') === null)
  check('the suppressed reload leaves the boot style unarmed',
    !again.document.documentElement.hasAttribute('data-dsh-opening-boot'))

  const fresh = run({ config: { oncePerSession: true } })
  check('a new session plays again', find(fresh.document, 'dsh-opening-overlay') !== null)
}

console.log('cooldown')
{
  const local = makeStorage()
  const first = run({ config: { cooldownMs: 60000 }, sharedLocal: local })
  check('the first load inside no cooldown plays', find(first.document, 'dsh-opening-overlay') !== null)
  playThrough(first)
  first.frameWindow.complete()
  check('the cooldown clock was written', local.getItem('dsh-opening:last-played') !== null)

  const second = run({ config: { cooldownMs: 60000 }, sharedLocal: local })
  check('a reload inside the cooldown window is suppressed', find(second.document, 'dsh-opening-overlay') === null)

  /* Backdate the clock past the window and it must play again. */
  local.setItem('dsh-opening:last-played', String(Date.now() - 120000))
  const third = run({ config: { cooldownMs: 60000 }, sharedLocal: local })
  check('a reload after the cooldown plays again', find(third.document, 'dsh-opening-overlay') !== null)

  const zero = run({ config: { cooldownMs: 0 }, sharedLocal: local })
  check('cooldownMs 0 never suppresses', find(zero.document, 'dsh-opening-overlay') !== null)
}

console.log('overlay construction')
{
  const r = run({ config: { showSkipHint: true, fadeMs: 300 } })
  const ov = find(r.document, 'dsh-opening-overlay')
  const fr = find(r.document, 'dsh-opening-frame')
  check('overlay mounted', !!ov)
  check('overlay is attached to <body>', ov && ov.parentNode === r.document.body)
  check('overlay is fixed and full-bleed', /position:fixed/.test(ov.style.cssText) && /inset:0/.test(ov.style.cssText))
  check('overlay z-index is 2147483000', /z-index:2147483000/.test(ov.style.cssText), ov.style.cssText.slice(0, 80))
  check('overlay carries the active marker', ov.getAttribute('data-dsh-opening') === 'active')
  check('overlay has the configured fade transition', /transition:opacity 300ms/.test(ov.style.cssText))
  check('boot style armed', r.document.documentElement.hasAttribute('data-dsh-opening-boot'))
  check('iframe mounted inside the overlay', fr && fr.parentNode === ov)
  check('iframe points at the plugin route', String(fr.src).startsWith('/dsh-opening/splash.html'), fr.src)
  const hint = find(r.document, 'dsh-opening-hint')
  check('skip hint rendered', !!hint)
  check('skip hint reads "Esc skip" in Chinese', hint.textContent === 'Esc \u8DF3\u8FC7', hint.textContent)
  check('the shipped file is pure ASCII', !/[^\x00-\x7F]/.test(SRC))
  check('load watchdog armed', r.timers.timeouts.some((t) => t.ms === 6000))
  check('public handle exposed', typeof r.window.DSHOpening === 'object' && typeof r.window.DSHOpening.play === 'function')
  check('the Escape listener is wired on window', (r.window._listeners.keydown || []).length === 1)
  check('no click listener by default', !(r.window._listeners.pointerdown || []).length)

  const noHint = run({ config: { showSkipHint: false } })
  check('showSkipHint:false renders no hint', find(noHint.document, 'dsh-opening-hint') === null)
}

console.log('skippable:false')
{
  const r = run({ config: { skippable: false } })
  check('no skip listeners when skippable is false',
    !(r.window._listeners.keydown || []).length && !(r.window._listeners.pointerdown || []).length)
}

console.log('load watchdog: only a document that never arrives counts as failure')
{
  /* The watchdog is now strictly a "the document never loaded" deadline. A load
     that cannot be introspected (cross-origin) is NOT a failure -- that was the
     bug. Once `load` fires, the animation's own runtime governs the ending. */
  const r = run({})
  const fr = find(r.document, 'dsh-opening-frame')
  check('watchdog armed at start', r.timers.timeouts.some((t) => t.ms === 6000))
  fr.dispatch('load', {})
  check('load retires the watchdog', !r.timers.timeouts.some((t) => t.ms === 6000))
  check('load arms the ending from the known duration', r.timers.timeouts.some((t) => t.ms === 20250 + 400))
  r.fireTimeouts(6000)
  check('a retired watchdog cannot remove the overlay', find(r.document, 'dsh-opening-overlay') !== null)

  /* A frame that never loads: the only case the watchdog still owns. */
  const dead = run({})
  dead.fireTimeouts(6000)
  check('a frame that never loads is removed after loadTimeoutMs', find(dead.document, 'dsh-opening-overlay') === null)
  check('watchdog clears the boot style', !dead.document.documentElement.hasAttribute('data-dsh-opening-boot'))
  check('a failed load does not consume the session flag', dead.window.sessionStorage.getItem('dsh-opening:session') === null)
  check('a failed load does not start the cooldown', dead.window.localStorage.getItem('dsh-opening:last-played') === null)
  check('a failed load is reported as load-timeout via the watchdog', /reason=load-timeout/.test(dead.beacons[0] || '') && /via=watchdog/.test(dead.beacons[0] || ''), dead.beacons[0])
}

console.log('completion')
{
  const r = run({ config: { fadeMs: 200 } })
  playThrough(r)
  check('a real load clears the watchdog', !r.timers.timeouts.some((t) => t.ms === 6000))
  check('a real load arms the same-origin poll', r.timers.intervals.some((t) => t.ms === 250))
  check('a real load arms the duration-based ending', r.timers.timeouts.some((t) => t.ms === 20250 + 400))
  check('the cooldown clock is not started by merely loading', r.window.localStorage.getItem('dsh-opening:last-played') === null)

  r.frameWindow.complete()
  check('the cooldown clock is started once the splash really ran', r.window.localStorage.getItem('dsh-opening:last-played') !== null)
  const ov = find(r.document, 'dsh-opening-overlay')
  check('overlay starts fading on completion', ov && ov.style.opacity === '0')
  check('overlay stops intercepting input', ov && ov.style.pointerEvents === 'none', ov && ov.style.pointerEvents)
  check('overlay marked done', ov && ov.getAttribute('data-dsh-opening') === 'done')
  check('boot style cleared at once, not after the fade', !r.document.documentElement.hasAttribute('data-dsh-opening-boot'))
  r.fireTimeouts(200 + 80)
  check('overlay removed after the fade', find(r.document, 'dsh-opening-overlay') === null)
  check('all timers stopped', r.timers.timeouts.length === 0 && r.timers.intervals.length === 0)
}

console.log('escape and click skip')
{
  const r = run({})
  r.window.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  check('Escape removes the overlay', find(r.document, 'dsh-opening-overlay') === null)
  check('Escape clears the boot style', !r.document.documentElement.hasAttribute('data-dsh-opening-boot'))

  const r2 = run({ config: { skipOnClick: true } })
  r2.window.dispatch('pointerdown', { preventDefault() {}, stopPropagation() {} })
  check('a click removes the overlay when enabled', find(r2.document, 'dsh-opening-overlay') === null)

  const r3 = run({})
  r3.window.dispatch('keydown', { key: 'a', preventDefault() {}, stopPropagation() {} })
  check('an unrelated key is ignored by default', find(r3.document, 'dsh-opening-overlay') !== null)

  const r4 = run({ config: { skipOnAnyKey: true } })
  r4.window.dispatch('keydown', { key: 'a', preventDefault() {}, stopPropagation() {} })
  check('skipOnAnyKey honours any key', find(r4.document, 'dsh-opening-overlay') === null)

  /* The animation's own Escape handler routes back through its event. */
  const r5 = run({})
  playThrough(r5)
  r5.frameWindow.DSHSplash.skip()
  check('the animation skipping itself ends the splash', find(r5.document, 'dsh-opening-overlay') === null)
  check('the animation skip path clears the boot style', !r5.document.documentElement.hasAttribute('data-dsh-opening-boot'))
}

console.log('escalation through the public handle')
{
  const r = run({})
  playThrough(r)
  r.window.DSHOpening.skip()
  check('DSHOpening.skip() ends the splash', find(r.document, 'dsh-opening-overlay') === null)
  check('DSHOpening.isPlaying() reports false after the end', r.window.DSHOpening.isPlaying() === false)
}

console.log('replay')
{
  const r = run({ config: { oncePerSession: true, fadeMs: 0 } })
  playThrough(r)
  r.frameWindow.complete()
  r.fireTimeouts(1000)
  check('splash gone before replay', find(r.document, 'dsh-opening-overlay') === null)

  const ok = r.window.DSHOpening.play()
  check('play() reports success', ok === true)
  check('play() raises the overlay again', find(r.document, 'dsh-opening-overlay') !== null)
  check('play() re-arms the boot style', r.document.documentElement.hasAttribute('data-dsh-opening-boot'))
  check('play() created a fresh iframe', find(r.document, 'dsh-opening-frame') !== null)
  check('play() is not refused by oncePerSession', r.window.DSHOpening.isPlaying() === true)
  check('play() refuses to stack a second splash', r.window.DSHOpening.play() === false)
}

console.log('non-http origin (the Electron shell serves dsh-app://app/)')
{
  /* No transport hint: the relative path would resolve against dsh-app://app/. */
  const bare = run({ origin: 'dsh-app:' })
  check('without a hint the src stays relative', String(find(bare.document, 'dsh-opening-frame').src).startsWith('/dsh-opening/splash.html'),
    find(bare.document, 'dsh-opening-frame').src)

  /* The boot row resolves the host origin and publishes it before the loader runs. */
  const hinted = run({
    origin: 'dsh-app:',
    beforeFactory: (w) => { w.__DSH_OPENING_BASE__ = 'http://127.0.0.1:19387' },
  })
  check('a resolved base is prepended to the splash url',
    String(find(hinted.document, 'dsh-opening-frame').src).startsWith('http://127.0.0.1:19387/dsh-opening/splash.html'),
    find(hinted.document, 'dsh-opening-frame').src)

  /* Without the boot row, the transport hint is the fallback. */
  const transport = run({
    origin: 'dsh-app:',
    beforeFactory: (w) => { w.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:29999/' } },
  })
  check('__DSH_TRANSPORT__.streamBaseUrl is used as the base and trailing slashes are trimmed',
    String(find(transport.document, 'dsh-opening-frame').src).startsWith('http://127.0.0.1:29999/dsh-opening/splash.html'),
    find(transport.document, 'dsh-opening-frame').src)

  /* An http origin must stay relative even if a base is present. */
  const httpWithBase = run({
    origin: 'http:',
    beforeFactory: (w) => { w.__DSH_OPENING_BASE__ = '' },
  })
  check('an http origin keeps the relative path', String(find(httpWithBase.document, 'dsh-opening-frame').src).startsWith('/dsh-opening/splash.html'),
    find(httpWithBase.document, 'dsh-opening-frame').src)
}

console.log('host-visible reporting')
{
  const r = run({})
  check('no beacon before the splash ends', r.beacons.length === 0)
  playThrough(r)
  r.frameWindow.complete()
  check('a beacon is sent when the splash ends', r.beacons.length === 1, r.beacons)
  const url = r.beacons[0] || ''
  check('the beacon hits the plugin route', url.startsWith('/dsh-opening/played?'), url)
  check('the beacon carries the reason', /reason=completed/.test(url), url)
  check('the beacon carries the viewport', /w=1440/.test(url) && /h=810/.test(url), url)
  check('the beacon carries a user agent', /ua=shim/.test(url), url)

  /* The reason distinguishes how a splash ended, which is what makes the
     observation useful: "key" vs "click" vs "api" vs "completed". */
  const s = run({})
  s.window.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  check('an Escape skip reports key', /reason=key/.test(s.beacons[0] || ''), s.beacons[0])

  const c = run({ config: { skipOnClick: true } })
  c.window.dispatch('pointerdown', { preventDefault() {}, stopPropagation() {} })
  check('a click skip reports click', /reason=click/.test(c.beacons[0] || ''), c.beacons[0])

  const api = run({})
  api.window.DSHOpening.skip()
  check('a programmatic skip reports api', /reason=api/.test(api.beacons[0] || ''), api.beacons[0])

  /* The decisive one: a load failure must be visible from the host, not silent. */
  const f = run({})
  f.fireTimeouts(6000)
  check('a failed load reports load-timeout', /reason=load-timeout/.test(f.beacons[0] || ''), f.beacons[0])

  /* A suppressed load reports nothing at all. */
  const n = run({ config: { enabled: false } })
  check('a suppressed load sends no beacon', n.beacons.length === 0)

  /* The beacon must respect the resolved base, like every other request. */
  const d = run({ origin: 'dsh-app:', beforeFactory: (w) => { w.__DSH_OPENING_BASE__ = 'http://127.0.0.1:19387' } })
  playThrough(d)
  d.frameWindow.complete()
  check('the beacon honours the resolved base',
    (d.beacons[0] || '').startsWith('http://127.0.0.1:19387/dsh-opening/played?'), d.beacons[0])
}

console.log('cross-origin frame (the Electron shell: dsh-app://app hosting an http iframe)')
{
  /* This is the exact shape of the reported bug: the loader could not read
     contentWindow, so the 6s watchdog removed the overlay while the animation
     was still playing ("只播放了一部分就进入软件了"). */
  const r = run({ crossOrigin: true })
  check('overlay still mounts', find(r.document, 'dsh-opening-overlay') !== null)
  check('reading contentWindow really does throw', (() => {
    try { void find(r.document, 'dsh-opening-frame').contentWindow.document; return false } catch (err) { return true }
  })())
  check('the splash URL carries a per-play token', typeof frameToken(r) === 'string' && frameToken(r).length > 8, frameToken(r))
  check('the watchdog is armed before load', !!r.timers.timeouts.find((t) => t.ms === 6000))

  /* THE regression. The frame loads and then says nothing at all -- no ready, no
     done, because nothing inside it can be observed cross-origin. The splash
     must still play in full and end on its own runtime. */
  find(r.document, 'dsh-opening-frame').dispatch('load', {})
  check('load alone clears the load watchdog', !r.timers.timeouts.some((t) => t.ms === 6000))
  check('load alone arms the ending from the known duration',
    r.timers.timeouts.some((t) => t.ms === 20250 + 400), r.timers.timeouts.map((t) => t.ms))
  r.fireTimeouts(6000)
  check('the watchdog cannot tear the overlay down after load', find(r.document, 'dsh-opening-overlay') !== null)
  r.fireTimeouts(20250 + 400)
  check('the splash ends by itself once the animation has run its length', find(r.document, 'dsh-opening-overlay') === null)
  check('the ending is reported as completed via the timer', /reason=completed/.test(r.beacons[0] || '') && /via=timer/.test(r.beacons[0] || ''), r.beacons[0])
  check('the report admits no ready message ever arrived', /detail=no-ready-message/.test(r.beacons[0] || ''), r.beacons[0])
  check('a silent cross-origin playback still counts for oncePerSession/cooldown', r.window.localStorage.getItem('dsh-opening:last-played') !== null)

  /* With a working message channel, the ending is exact and marked as such. */
  const m = run({ crossOrigin: true })
  find(m.document, 'dsh-opening-frame').dispatch('load', {})
  const originalEnding = m.timers.timeouts.find((t) => t.ms === 20250 + 400)
  frameMessage(m, { type: 'ready', duration: 20250 })
  check('a ready message preserves or shortens the original deadline',
    m.timers.timeouts.some((t) => t.ms > 0 && t.ms <= 20250 + 400) &&
    !m.timers.timeouts.includes(originalEnding))
  frameMessage(m, { type: 'done', reason: 'completed' })
  check('a done message ends the splash immediately', find(m.document, 'dsh-opening-overlay') === null)
  check('the message ending is reported via=message', /via=message/.test(m.beacons[0] || ''), m.beacons[0])
  check('the report notes the ready message arrived', /detail=ready-message/.test(m.beacons[0] || ''), m.beacons[0])

  /* Anything that does not carry this play's token is ignored. */
  const fake = run({ crossOrigin: true })
  fake.window.dispatch('message', { source: fake.frameWindow, data: { source: 'dsh-opening-splash', type: 'done', reason: 'completed' } })
  check('a message with no token is ignored', find(fake.document, 'dsh-opening-overlay') !== null)
  fake.window.dispatch('message', { source: fake.frameWindow, data: { source: 'dsh-opening-splash', k: 'wrong-token', type: 'done' } })
  check('a message with the wrong token is ignored', find(fake.document, 'dsh-opening-overlay') !== null)
  fake.window.dispatch('message', { source: fake.frameWindow, data: { source: 'someone-else', k: frameToken(fake), type: 'done' } })
  check('a message without our source tag is ignored', find(fake.document, 'dsh-opening-overlay') !== null)
  frameMessage(fake, { type: 'done', reason: 'completed' })
  check('a correctly tokened message is accepted', find(fake.document, 'dsh-opening-overlay') === null)

  /* Skip intent crosses the boundary too. */
  const k = run({ crossOrigin: true })
  find(k.document, 'dsh-opening-frame').dispatch('load', {})
  frameMessage(k, { type: 'skip', how: 'key' })
  check('a key skip from inside the frame ends the splash', find(k.document, 'dsh-opening-overlay') === null)

  /* Click intent is ignored unless skipOnClick is on. */
  const c1 = run({ crossOrigin: true })
  find(c1.document, 'dsh-opening-frame').dispatch('load', {})
  frameMessage(c1, { type: 'skip', how: 'click' })
  check('a click skip is ignored by default', find(c1.document, 'dsh-opening-overlay') !== null)

  const c2 = run({ crossOrigin: true, config: { skipOnClick: true } })
  find(c2.document, 'dsh-opening-frame').dispatch('load', {})
  frameMessage(c2, { type: 'skip', how: 'click' })
  check('a click skip works when skipOnClick is on', find(c2.document, 'dsh-opening-overlay') === null)

  /* A document that never loads at all is still cleaned up. */
  const dead = run({ crossOrigin: true })
  dead.fireTimeouts(6000)
  check('a frame that never loads is cleaned up by the watchdog', find(dead.document, 'dsh-opening-overlay') === null)
  check('a never-loaded frame reports load-timeout', /reason=load-timeout/.test(dead.beacons[0] || ''), dead.beacons[0])
  check('a never-loaded frame does not count as a playback', dead.window.localStorage.getItem('dsh-opening:last-played') === null)
}

console.log('defaults that keep the opening intact')
{
  const r = run({})
  check('the skip hint is off by default', find(r.document, 'dsh-opening-hint') === null)
  check('click-to-skip is off by default (no window pointerdown listener)', !(r.window._listeners.pointerdown || []).length)
  check('Escape still works by default', (r.window._listeners.keydown || []).length === 1)
  r.window.dispatch('pointerdown', { preventDefault() {}, stopPropagation() {} })
  check('a stray click does not end the splash', find(r.document, 'dsh-opening-overlay') !== null)
  r.window.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  check('Escape ends the splash', find(r.document, 'dsh-opening-overlay') === null)

  const hinted = run({ config: { showSkipHint: true } })
  check('the hint still renders when explicitly enabled', find(hinted.document, 'dsh-opening-hint') !== null)
}

console.log('regressions for suppression and duration limits')
{
  const r = run({ search: '?noopening' })
  check('suppressed playback is idle', r.window.DSHOpening.isPlaying() === false)
  check('suppressed playback can be replayed', r.window.DSHOpening.play() === true)
  check('replay mounts an overlay', !!find(r.document, 'dsh-opening-overlay'))
  const capped = run({ crossOrigin: true, config: { maxDurationMs: 1000 } })
  find(capped.document, 'dsh-opening-frame').dispatch('load', {})
  capped.fireTimeouts(1000)
  check('duration limit reports capped', /reason=capped/.test(capped.beacons[0] || ''))
  const locked = run({ config: { skippable: false, skipOnClick: true } })
  find(locked.document, 'dsh-opening-frame').dispatch('load', {})
  locked.frameWindow.document.dispatch?.('keydown', { key: 'Escape' })
  check('unskippable same-origin frame has no key skip handler', !(locked.frameWindow.document._listeners.keydown || []).length)
}
console.log(failures === 0 ? '\nALL BROWSER-HALF CHECKS PASSED' : `\n${failures} BROWSER-HALF CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
