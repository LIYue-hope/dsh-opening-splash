// Executes the browser half for real against a minimal DOM shim. This is not a
// rendering test -- it cannot prove the animation looks right -- but it does
// execute every decision the loader makes: suppression, overlay construction,
// skip wiring, the load watchdog, the completion path and the cleanup.
//
// The bridge cases below run the host's own generated bridge script, so the
// message ORDER is the one a real frame produces. A shortcut that hand-builds
// the messages can pass while the real order is wrong; that is exactly how a
// "done before skip" ordering bug survived the first round of these checks.
//
// Run: node browser-half-check.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import { bridgeScript, normalizeConfig } from '../lib/index.js'

const SRC = fs.readFileSync(new URL('../assets/opening.js', import.meta.url), 'utf8')

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

/* ------------------------------- DOM shim -------------------------------- */

function makeNode(tag) {
  const node = {
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
  /* A browser exposes the standard mask property and an alias for the prefixed
     spelling; the reveal writes both, so the shim accepts both. `mask` is the
     reading side, used by the checks to see how far the hole has grown. */
  let mask = ''
  Object.defineProperty(node.style, 'maskImage', {
    get() { return mask },
    set(value) { mask = String(value) },
  })
  Object.defineProperty(node.style, 'webkitMaskImage', {
    get() { return mask },
    set(value) { mask = String(value) },
  })
  return node
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
    /* The harness's handle on the frame itself: the loader's own reads still
       throw, but the checks can announce readiness the way the served bridge
       does when a same-origin read is not available. */
    frame: null,
    /* The one call the parent may make into a cross-origin frame. Given a body
       so the checks can stand in for it; by default it keeps what it is told. */
    postMessage(data) { target.received.push(data) },
    received: [],
    beReady() {
      target.__splashReady = true
      target.DSHSplash = { duration: 20250, skip() {} }
    },
  }
  target.frame = target
  const proxy = new Proxy(target, {
    get(_t, prop) {
      /* `postMessage` is the one call a real cross-origin WindowProxy does
         answer -- it is how the two sides talk at all -- so the shim must not
         block it, or the parent could never reach the frame and these tests
         would pass for the wrong reason. Everything else the loader reads
         (DSHSplash, document, finished) still throws, exactly like a browser. */
      if (prop === 'frame' || prop === 'post' || prop === 'sent' || prop === 'beReady' || prop === 'postMessage') {
        return target[prop]
      }
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
function run({ config = {}, search = '', hash = '', origin = 'http:', crossOrigin = false, sharedSession, sharedLocal, beforeFactory, masks = false, noHref = false } = {}) {
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
    /* The loader announces its ending with a window event; a shim without this
       would swallow that announcement and the throw would go unnoticed. */
    dispatchEvent(event) {
      window.dispatch(event.type, event)
      return true
    },
    sessionStorage: sharedSession || makeStorage(),
    localStorage: sharedLocal || makeStorage(),
  }
  frameWindow = crossOrigin
    ? makeBlockedWindow((data) => window.dispatch('message', { source: frameWindow, data }))
    : makeFrameWindow()
  /* A real document always exposes `href`; message targeting resolves against it,
     so the shim must carry one or it would quietly mask a broken base. */
  const location = { href: `${origin}//dsh.test/`, search, hash, protocol: origin }
  /* `noHref` models the document that cannot supply one. */
  if (noHref) delete location.href
  if (beforeFactory) beforeFactory(window)

  /* createElement('iframe') hands back a node whose contentWindow is the stub. */
  const realCreate = document.createElement.bind(document)
  document.createElement = (tag) => {
    const node = realCreate(tag)
    if (String(tag).toLowerCase() === 'iframe') {
      node.contentWindow = frameWindow
      /* The overlay fills the viewport, so the frame's rect is the viewport's. */
      node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 810, width: 1440, height: 810 })
    }
    return node
  }

  /* Mask support is a capability, not a given: `masks` decides whether this run
     is on an engine the reveal can animate. */
  const CSS = { supports: (prop) => masks && (prop === 'mask-image' || prop === '-webkit-mask-image') }
  const frames = []
  const requestAnimationFrameShim = (fn) => { frames.push(fn); return { fn } }

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
  /* Run the animation frames the reveal asked for, in order. */
  let frameTime = 0
  const flushFrames = (count = 200) => {
    for (let guard = 0; frames.length && guard < count; guard++) {
      frames.shift()(frameTime)
      frameTime += 16
    }
  }

  const factory = new Function(
    'window', 'document', 'location', 'CustomEvent',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'console',
    'sessionStorage', 'localStorage', 'navigator', 'fetch', 'Image',
    'CSS', 'requestAnimationFrame',
    `"use strict";\n${SRC}\n`,
  )
  const beacons = []
  const fetchStub = (url) => { beacons.push(String(url)); return Promise.resolve({ ok: true }) }
  factory(
    window, document, location, CustomEvent,
    setTimeoutShim, setIntervalShim, clearShim, clearShim, { log() {}, warn() {} },
    window.sessionStorage, window.localStorage,
    { userAgent: 'shim/1.0' }, fetchStub, class { constructor() { this.src = '' } },
    CSS, requestAnimationFrameShim,
  )

  return { window, document, frameWindow, timers, fireTimeouts, flushFrames, beacons }
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

/** Announce the frame document arriving, as its load event does. */
function armCrossOrigin(r) {
  r.frameWindow.frame.beReady()
  find(r.document, 'dsh-opening-frame').dispatch('load', {})
}

/**
 * Deliver a message the way the host-appended bridge does.
 *
 * The payload wins where the two overlap: a real bridge message already carries
 * the token the frame was loaded with, so a bridge built with the parent's own
 * token (see `makeBridge`) hands over a message the parent accepts.
 */
function frameMessage(r, data) {
  r.window.dispatch('message', {
    source: r.frameWindow,
    data: Object.assign({ source: 'dsh-opening-splash', k: frameToken(r) }, data),
  })
}
/**
 * Run the real bridge script inside a stub animation document.
 *
 * This is the frame's own half of the protocol: the host builds it from its
 * config and serves it with the animation, and it is what actually decides when
 * to report a gesture. Everything it posts is queued in order, so the checks
 * assert the ORDER the parent would really receive.
 */
function makeBridge(config, token = 'bridge-token') {
  const listeners = {}
  const queue = []
  const parent = { postMessage: (m) => queue.push(m) }
  const win = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
    DSHSplash: {
      duration: 20250,
      /* The animation's own finish(): it hides the clip and announces it. */
      skip() { for (const fn of (listeners['dsh:splash-complete'] || []).slice()) fn({ detail: { reason: 'skipped' } }) },
    },
  }
  const doc = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) {
      const list = listeners[type]
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }
  vm.runInNewContext(
    bridgeScript(normalizeConfig(config)).replace(/^<script>/, '').replace(/<\/script>$/, ''),
    {
      window: win,
      document: doc,
      parent,
      /* The token the host put in the frame's URL, so what the bridge reports
         carries the same one the parent is waiting for. */
      location: { search: '?k=' + token },
      URLSearchParams,
      fetch: () => Promise.resolve({}),
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  )
  queue.length = 0
  return {
    listeners,
    queue,
    /** Fire an event at the frame's document, as a real gesture would. */
    fire(type, event) {
      for (const fn of (listeners[type] || []).slice()) {
        fn({ type, clientX: 120, clientY: 90, preventDefault() {}, stopImmediatePropagation() {}, ...event })
      }
    },
    /** Hand the parent everything this frame said, in the order it said it. */
    say(r) {
      for (const m of queue.splice(0)) frameMessage(r, m)
    },
    /** Deliver one message from the parent into the frame. */
    tell(message) {
      for (const fn of (listeners.message || []).slice()) {
        fn({ source: parent, data: { source: 'dsh-opening-parent', k: token, ...message } })
      }
    },
  }
}

/** The two colour stops of the mask, as lengths. The centre is not a stop. */
const maskStops = (style) => [...style.maskImage.matchAll(/(?:rgba\([^)]*\)|#000)\s+([\d.]+)px/g)]
  .map((m) => Number(m[1]))

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
/* ------------------------- the user's own switches ------------------------- */

/* Where the Settings page stores its switches. The loader is the half that reads
   them, at boot, so the key and the field names are a cross-file contract. */
const PREFS_KEY = 'dsh-opening-splash:settings'

/** A storage area pre-loaded with the switches the Settings page would write. */
function prefsStorage(prefs) {
  const area = makeStorage()
  area.setItem(PREFS_KEY, JSON.stringify(prefs))
  return area
}

/** The element a click would land on: the frame sits inside the overlay. */
const OVERLAY_ID = 'dsh-opening-overlay'

function doubleClick(r, point) {
  r.window.dispatch('dblclick', { clientX: point.x, clientY: point.y })
}

const rings = (r) => (find(r.document, 'dsh-opening-ripples')?.children || [])
  .filter((child) => child.getAttribute('data-dsh-opening-ripple') === 'ring')

const overlayStyle = (r) => find(r.document, OVERLAY_ID).style

/**
 * The radius the mask's hole has reached.
 *
 * The hole is the transparent region, so its radius is the FIRST stop -- the
 * point where the splash starts showing again, not where the black is total.
 */
function holeRadius(r) {
  return maskStops(overlayStyle(r))[0] ?? null
}

{
  /* Off by default: a double click must not end the opening. */
  const off = run()
  doubleClick(off, { x: 400, y: 300 })
  check('a double click does nothing by default', find(off.document, OVERLAY_ID) !== null)

  /* On: the opening ends with the reveal rather than the fade. */
  const on = run({ config: { skipOnDoubleClick: true }, masks: true })
  /* Listening before the gesture: the ending is announced while the reveal is
     still running, which is the whole point of announcing it from the teardown
     rather than from the fade. */
  const completion = []
  on.window.addEventListener('dsh:opening-complete', (event) => completion.push(event.detail.reason))
  doubleClick(on, { x: 300, y: 200 })
  const node = find(on.document, OVERLAY_ID)
  check('same-origin animation stays visible during reveal', !on.frameWindow.finished && !find(on.frameWindow.document, 'splash').hidden)
  const completionBefore = completion.slice()
  check('a double click ends the opening when enabled', node !== null)
  check('the ending is reported as a double click', on.beacons.some((url) => url.includes('reason=dblclick')))
  check('the reveal reports itself as a skip', on.beacons.some((url) => url.includes('via=skip')))

  /* Two rings, from the point the gesture landed on. */
  const list = rings(on)
  check('two ripple rings are drawn', list.length === 2)
  check('both rings are centred on the double click',
    list.every((ring) => ring.style.cssText.includes('left:300px') && ring.style.cssText.includes('top:200px')))
  check('the rings are animated from the plugin, not the page', on.document.getElementById('dsh-opening-ripple-keyframes') !== null)
  check('the inner ring is the smaller of the two',
    Number(/width:([\d.]+)px/.exec(list[0].style.cssText)[1]) < Number(/width:([\d.]+)px/.exec(list[1].style.cssText)[1]))
  check('the base ring starts last, behind the leading one',
    list[0].style.cssText.includes('180ms') && !list[1].style.cssText.includes('180ms'))

  /* The splash itself is masked away from that same point. */
  const start = holeRadius(on)
  check('the splash starts masked with no hole', start !== null && start === 0)
  check('the mask is centred on the double click',
    overlayStyle(on).maskImage.includes('circle at 300px 200px'))

  /* The mask's geometry, not just its spelling: the first stop is the hole's
     radius and the second a short shoulder past it. Reversing them -- or
     passing a fraction where a length belongs -- renders as if there were no
     hole at all, which is how the first build of this shipped. */
  const startStops = maskStops(overlayStyle(on))
  check('the mask starts with an ordered pair of stops',
    startStops.length === 2 && startStops[0] === 0 && startStops[1] === 0, startStops)

  check('the app underneath is revealed, not the boot canvas',
    !on.document.documentElement.hasAttribute('data-dsh-opening-boot'))
  /* Nothing behind the hole may be clicked through the splash. */
  check('the overlay swallows clicks during the reveal', overlayStyle(on).pointerEvents === 'none')

  /* And the hole grows to clear the viewport. */
  on.flushFrames(40)
  const middle = holeRadius(on)
  check('the reveal grows gradually', middle > 0 && middle < Math.hypot(1140, 610), middle)
  check('rings are outside the splash mask', list.every((ring) => ring.parentNode !== node))
  check('the animation iframe remains attached during expansion', find(on.document, 'dsh-opening-frame') !== null)
  on.flushFrames()
  const endStops = maskStops(overlayStyle(on))
  const farCorner = Math.hypot(1440 - 300, 810 - 200)
  check('the hole expands past the far corner', endStops[0] >= farCorner, [endStops[0], farCorner])
  check('and stays a length rather than a runaway number', endStops[0] < farCorner + 100, endStops[0])
  check('the stops stay ordered at the end', endStops[0] <= endStops[1], endStops)
  check('the edge stays a soft shoulder, not a second hole',
    endStops[1] - endStops[0] < endStops[0] / 2, endStops)
  check('the hole radius agrees with the first stop', holeRadius(on) === endStops[0])
  check('the mask is written for both spellings',
    overlayStyle(on).webkitMaskImage === overlayStyle(on).maskImage)
  check('playback document is removed only once the reveal covers the viewport', find(on.document, 'dsh-opening-frame') === null)

  /* The reveal announces the ending like the fade does: a caller waiting on the
     event must not wait forever just because the reveal was the ending. */
  check('the reveal announced the ending before the overlay went away',
    JSON.stringify(completionBefore) === JSON.stringify(['dblclick']), completionBefore)
  on.fireTimeouts(5000)
  check('the overlay is removed when the reveal ends', find(on.document, OVERLAY_ID) === null)
  check('wave layer is cleaned up', find(on.document, 'dsh-opening-ripples') === null)
  check('the reveal is not left as a fade', node.getAttribute('data-dsh-opening') === 'active')
  check('and the ending is announced exactly once',
    JSON.stringify(completion) === JSON.stringify(['dblclick']), completion)
}

{
  /* A host that turned the reveal off still honours the gesture, plainly. */
  const plain = run({ config: { skipOnDoubleClick: true, rippleReveal: false }, masks: true })
  const plainDone = []
  plain.window.addEventListener('dsh:opening-complete', (event) => plainDone.push(event.detail.reason))
  doubleClick(plain, { x: 100, y: 100 })
  check('rippleReveal:false still ends the opening', plainDone.length === 1 && plainDone[0] === 'dblclick')
  check('and draws no rings', rings(plain).length === 0)
}

{
  /* An engine that cannot animate a mask must still end the opening. */
  const noMask = run({ config: { skipOnDoubleClick: true } })
  const noMaskDone = []
  noMask.window.addEventListener('dsh:opening-complete', (event) => noMaskDone.push(event.detail.reason))
  doubleClick(noMask, { x: 100, y: 100 })
  check('without mask support the ending still happens', noMaskDone.length === 1 && noMaskDone[0] === 'dblclick')
  check('without mask support no rings are drawn', rings(noMask).length === 0)
}

{
  /* The switches the Settings page wrote are what makes the gesture live. */
  const shared = prefsStorage({ skipOnDoubleClick: true, defaultName: false })
  const stored = run({ sharedLocal: shared, masks: true })
  doubleClick(stored, { x: 20, y: 20 })
  check('the stored switch enables the double click', rings(stored).length === 2)

  const unsaved = run({ masks: true })
  doubleClick(unsaved, { x: 20, y: 20 })
  check('without the stored switch the gesture stays off', rings(unsaved).length === 0)

  /* A stored switch that is not a boolean is ignored rather than believed. */
  const junk = run({ sharedLocal: prefsStorage({ skipOnDoubleClick: 'yes' }), masks: true })
  doubleClick(junk, { x: 20, y: 20 })
  check('a non-boolean stored switch is ignored', rings(junk).length === 0)

  const blocked = run({ sharedLocal: { getItem() { throw new Error('blocked') }, setItem() {} }, masks: true })
  doubleClick(blocked, { x: 20, y: 20 })
  check('unreadable storage falls back to the config', rings(blocked).length === 0)
}

{
  /* The same gesture reported by the frame, which is the only channel on the
     Electron shell: the point arrives in the frame's coordinates. */
  const viaFrame = run({ config: { skipOnDoubleClick: true }, crossOrigin: true, masks: true })
  armCrossOrigin(viaFrame)
  frameMessage(viaFrame, { type: 'skip', how: 'dblclick', point: { x: 120, y: 90 } })
  const list = rings(viaFrame)
  check('a double click reported by the frame opens the reveal', list.length === 2)
  check('the frame\'s point is translated into page coordinates',
    list[0].style.cssText.includes('left:120px') && list[0].style.cssText.includes('top:90px'))

  /* Without a point, the reveal still happens -- from the middle of the screen. */
  const noPoint = run({ config: { skipOnDoubleClick: true }, crossOrigin: true, masks: true })
  armCrossOrigin(noPoint)
  frameMessage(noPoint, { type: 'skip', how: 'dblclick' })
  check('a point-less report still reveals', rings(noPoint).length === 2)
  check('and centres on the middle of the viewport',
    overlayStyle(noPoint).maskImage.includes('circle at 720px 405px'))

  /* The message is only honoured when the config allows the gesture. */
  const refused = run({ crossOrigin: true, masks: true })
  armCrossOrigin(refused)
  frameMessage(refused, { type: 'skip', how: 'dblclick', point: { x: 10, y: 10 } })
  check('a reported double click is refused when the setting is off', rings(refused).length === 0)
}

/* ------------------- the frame's own bridge, end to end ------------------- */

console.log('the frame bridge, driven as the browser drives it')
{
  /* The bridge reports the gesture BEFORE stopping the animation. Stopping it
     dispatches the completion the parent listens for, so the other order ends
     the opening with the plain fade and the reveal never runs. This is the
     regression a hand-built message sequence cannot catch. */
  const r = run({ config: { skipOnDoubleClick: true }, crossOrigin: true, masks: true })
  armCrossOrigin(r)
  const bridge = makeBridge({ skipOnDoubleClick: true }, frameToken(r))
  bridge.fire('dblclick')
  check('the bridge reports only the gesture and leaves playback running',
    JSON.stringify(bridge.queue.map((m) => m.type)) === JSON.stringify(['skip']), bridge.queue.map((m) => m.type))
  bridge.say(r)
  check('the reveal runs on the real message order', rings(r).length === 2,
    { beacons: r.beacons, rings: rings(r).length })
  check('and the ending is the double click, not a plain skip',
    r.beacons.some((url) => url.includes('reason=dblclick')) && !r.beacons.some((url) => url.includes('reason=skipped')))
  check('the completion the bridge caused does not end the opening twice',
    r.window.DSHOpening.isPlaying() === false && rings(r).length === 2)
}
{
  /* A real animation completion still ends the opening the ordinary way. */
  const r = run({ config: { skipOnDoubleClick: true }, crossOrigin: true, masks: true })
  armCrossOrigin(r)
  const done = []
  r.window.addEventListener('dsh:opening-complete', (event) => done.push(event.detail.reason))
  frameMessage(r, { type: 'done', reason: 'completed' })
  check('a genuine completion still ends the opening', JSON.stringify(done) === JSON.stringify(['completed']))
  check('and does not become a reveal', rings(r).length === 0)
}
{
  /* The frame cannot read the page's storage, so the parent must project the
     switches into it -- otherwise a switch turned on in Settings does nothing
     on the Electron shell, where the served config is the bridge's only input. */
  const storage = prefsStorage({ skipOnDoubleClick: true })
  const r = run({ sharedLocal: storage, crossOrigin: true, masks: true })
  armCrossOrigin(r)
  const bridge = makeBridge({})
  check('the served bridge starts without the gesture', (bridge.listeners.dblclick || []).length === 0)

  const received = r.frameWindow.frame.received
  received.length = 0
  frameMessage(r, { type: 'ready', duration: 20250 })
  const prefs = received.find((m) => m.type === 'prefs')
  check('the parent projects its switches into the frame', Boolean(prefs))
  check('and projects the double-click switch it has on', prefs && prefs.prefs.skipOnDoubleClick === true)

  bridge.tell({ type: 'prefs', prefs: prefs.prefs })
  check('the frame arms the gesture the host never wired', (bridge.listeners.dblclick || []).length === 1)
  check('without arming the gesture the user did not ask for', (bridge.listeners.pointerdown || []).length === 0)
}
{
  /* Each switch arms and disarms its own gesture, and re-telling changes nothing. */
  const r = run({ config: { skipOnClick: true }, crossOrigin: true, masks: true })
  const bridge = makeBridge({ skipOnClick: true })
  bridge.tell({ type: 'prefs', prefs: { skipOnClick: true, skipOnDoubleClick: true } })
  check('the double click arms alongside the single click', (bridge.listeners.dblclick || []).length === 1)
  bridge.tell({ type: 'prefs', prefs: { skipOnClick: true, skipOnDoubleClick: true } })
  check('a repeated projection does not double-arm', (bridge.listeners.dblclick || []).length === 1)
  bridge.tell({ type: 'prefs', prefs: { skipOnClick: true, skipOnDoubleClick: false } })
  check('turning the switch off disarms just that gesture',
    (bridge.listeners.dblclick || []).length === 0 && (bridge.listeners.pointerdown || []).length === 1)
  void r
}
{
  /* With both gestures on, the frame's first press must wait too: the frame
     reports a click the parent would honour immediately otherwise. */
  const r = run({ config: { skipOnClick: true, skipOnDoubleClick: true }, crossOrigin: true, masks: true })
  armCrossOrigin(r)
  const bridge = makeBridge({ skipOnClick: true, skipOnDoubleClick: true })
  bridge.fire('pointerdown')
  check('the frame holds a first press back while the double click is live',
    bridge.queue.length === 0, bridge.queue.map((m) => m.type))

  /* With only the single click on, it reports at once as it always did. */
  const clickOnly = makeBridge({ skipOnClick: true })
  clickOnly.fire('pointerdown')
  check('a click-only frame still reports the press at once',
    JSON.stringify(clickOnly.queue.map((m) => m.how)) === JSON.stringify(['click']))
}

{
  /* With both gestures on, a single click must wait out the double-click
     interval instead of ending the opening on the first half of a double click. */
  const both = run({ config: { skipOnClick: true, skipOnDoubleClick: true }, masks: true })
  const clicked = () => find(both.document, OVERLAY_ID) === null
  both.window.dispatch('pointerdown', {})
  check('one click alone does not end the opening', !clicked())
  both.fireTimeouts(400)
  check('the click ends the opening once no second click follows', clicked())

  const twice = run({ config: { skipOnClick: true, skipOnDoubleClick: true }, masks: true })
  twice.window.dispatch('pointerdown', {})
  twice.window.dispatch('pointerdown', {})
  twice.fireTimeouts(400)
  check('a second click cancels the single-click ending', find(twice.document, OVERLAY_ID) !== null)

  /* Double click alone leaves the single click out of it entirely. */
  const dblOnly = run({ config: { skipOnDoubleClick: true }, masks: true })
  dblOnly.window.dispatch('pointerdown', {})
  dblOnly.fireTimeouts(400)
  check('with only the double click on, a single click does nothing', find(dblOnly.document, OVERLAY_ID) !== null)

  /* Escape keeps working however the gestures are set. */
  const escape = run({ config: { skipOnDoubleClick: true }, masks: true })
  escape.window.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  check('Escape still ends the opening', find(escape.document, OVERLAY_ID) === null)

  /* The hint names the gesture the user actually has. */
  const hinted = run({ config: { skipOnDoubleClick: true, showSkipHint: true } })
  check('the hint names the double click when it is on',
    find(hinted.document, 'dsh-opening-hint').textContent.includes('\u53cc\u51fb'))
  const plainHint = run({ config: { showSkipHint: true } })
  check('the hint stays Esc-only otherwise',
    find(plainHint.document, 'dsh-opening-hint').textContent === 'Esc \u8DF3\u8fc7')
}

/* --------------------- the name the opening shows --------------------- */

{
  /* The published name is how the account integration reaches the animation. */
  const named = run()
  named.window.DSHOpening.setIdentity('Alice')
  check('a published name is kept as published', named.window.__DSH_OPENING_IDENTITY__ === 'Alice')

  /* The "restore the default name" switch withdraws it, and a name arriving
     afterwards must not slip back in. */
  const restored = run({ sharedLocal: prefsStorage({ defaultName: true }) })
  restored.window.DSHOpening.setIdentity('Alice')
  check('the switch withdraws the account name', restored.window.__DSH_OPENING_IDENTITY__ === null)

  /* Turning it back off leaves the name the page already had. */
  restored.window.DSHOpening.setPrefs({ defaultName: false })
  check('turning the switch off restores the name', restored.window.__DSH_OPENING_IDENTITY__ === 'Alice')

  /* A deployment can pin the default name, whatever the browser stored. */
  const pinned = run({ config: { revertName: true } })
  pinned.window.DSHOpening.setIdentity('Alice')
  check('the config pins the default name', pinned.window.__DSH_OPENING_IDENTITY__ === null)

  /* The identity handed to the frame follows the same policy. */
  const framed = run({ sharedLocal: prefsStorage({ defaultName: true }) })
  const sent = []
  framed.frameWindow.postMessage = (data) => sent.push(data)
  framed.window.DSHOpening.setIdentity('Alice')
  check('the frame is told the default name', sent.some((data) => data.type === 'identity' && data.label === null),
    sent)
  /* And the published name really is the account's when the switch is off. */
  const open = run()
  const openSent = []
  open.frameWindow.postMessage = (data) => openSent.push(data)
  open.window.DSHOpening.setIdentity('Alice')
  check('the frame is told the account name otherwise',
    openSent.some((data) => data.type === 'identity' && data.label === 'Alice'), openSent)

  /* A document with no readable href must not cost the frame its name: the
     throw would be swallowed as "the account was unavailable". */
  const noHref = run({ noHref: true })
  const noHrefSent = []
  noHref.frameWindow.postMessage = (data) => noHrefSent.push(data)
  noHref.window.DSHOpening.setIdentity('Alice')
  check('a document without href still reaches the frame',
    noHrefSent.some((data) => data.type === 'identity'), noHrefSent)
}

console.log(failures === 0 ? '\nALL BROWSER-HALF CHECKS PASSED' : `\n${failures} BROWSER-HALF CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
