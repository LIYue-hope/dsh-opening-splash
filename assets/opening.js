/*!
 * dsh-opening-splash - browser half.
 *
 * Paints a full-screen overlay before the app has a chance to show anything,
 * plays the opening animation inside it, then fades the overlay away.
 *
 * Served by the host half at /dsh-opening/opening.js with a prelude that
 * defines `window.__DSH_OPENING__` (the normalized plugin config). This file
 * is pure ASCII on purpose: every non-ASCII character is a \u escape, so no
 * shell round-trip can turn it into mojibake.
 *
 * Nothing here is allowed to break the host page. Every step is guarded, the
 * iframe carries a hard watchdog, and a failure to load simply removes the
 * overlay instead of leaving the user staring at a black screen.
 */
(function () {
  'use strict'

  /* Re-entrancy: the plugin injects through two channels (a structured row and
     a tapIndex fallback), and a page can end up with both script tags. */
  if (window.__DSH_OPENING_LOADED__) return
  window.__DSH_OPENING_LOADED__ = true

  var CFG = window.__DSH_OPENING__ || {}

  var OVERLAY_ID = 'dsh-opening-overlay'
  var FRAME_ID = 'dsh-opening-frame'
  var HINT_ID = 'dsh-opening-hint'
  var PLAYED_PATH = '/dsh-opening/played'
  var SESSION_KEY = 'dsh-opening:session'
  var STORE_KEY = 'dsh-opening:last-played'
  /* Slack after the animation's own runtime before the overlay is taken away,
     for the case where nothing inside the frame can be observed. The animation
     fades its curtain in over its last 320 ms, so this stays invisible. */
  var COMPLETION_TAIL_MS = 400

  var overlay = null
  var frame = null
  var hint = null
  var finished = false
  var playbackStarted = false
  /* Reported by the animation over postMessage. A bonus channel: the splash's
     lifetime never depends on it, because on the Electron shell it may not
     arrive at all. */
  var frameReady = false
  var frameDuration = 0
  /* Which signal armed the ending ('load' | 'message'), for the diagnostics. */
  var lastArmVia = ''
  /* Per-play secret echoed by the frame. Authenticating the sender by a token
     avoids depending on WindowProxy identity, which is not guaranteed to
     compare equal across origins. */
  var messageToken = ''
  var pollTimer = 0
  var capTimer = 0
  var capDeadline = 0
  var loadTimer = 0
  var hintTimer = 0
  var detach = []

  function log() {
    if (!CFG.debug) return
    try {
      console.log.apply(console, ['[dsh-opening]'].concat(Array.prototype.slice.call(arguments)))
    } catch (err) { /* a console that cannot log is not our problem */ }
  }

  /* --------------------------- skip / suppression --------------------------- */

  /* Escape hatches that work even when the plugin is misconfigured:
     ?noopening  - append to the URL (or #noopening) to suppress one load. */
  function urlSuppressed() {
    try {
      if (/(?:^|[?&])noopening(?:=[^&]*)?(?:&|$)/.test(String(location.search || ''))) return true
      if (/(?:^|#)noopening(?:$|[^\w-])/.test(String(location.hash || ''))) return true
    } catch (err) { /* an opaque origin can still play the splash */ }
    return false
  }

  function shouldPlay() {
    if (CFG.enabled === false) { log('disabled by config'); return false }
    if (urlSuppressed()) { log('suppressed by ?noopening'); return false }
    try {
      if (CFG.oncePerSession && sessionStorage.getItem(SESSION_KEY) === '1') {
        log('already played in this session')
        return false
      }
    } catch (err) { /* storage blocked: fall through and play */ }
    try {
      if (Number(CFG.cooldownMs) > 0) {
        var last = Number(localStorage.getItem(STORE_KEY) || 0)
        if (last > 0 && Date.now() - last < Number(CFG.cooldownMs)) { log('inside cooldown'); return false }
      }
    } catch (err) { /* storage blocked: fall through and play */ }
    return true
  }

  function markPlayed() {
    try { sessionStorage.setItem(SESSION_KEY, '1') } catch (err) { /* ignore */ }
    try { localStorage.setItem(STORE_KEY, String(Date.now())) } catch (err) { /* ignore */ }
  }

  /* --------------------------- url resolution ------------------------------- */

  /* In a browser the page origin IS the host, so a relative path is correct.
     The Electron shell serves the document from `dsh-app://app/`, where a
     relative path would resolve against the packaged dist and 404; there the
     host origin is published on `__DSH_TRANSPORT__` before any row is applied.
     `window.__DSH_OPENING_BASE__` is the value the boot row already resolved,
     reused here so both halves always agree on one base. */
  function baseUrl() {
    try {
      if (typeof window.__DSH_OPENING_BASE__ === 'string') return window.__DSH_OPENING_BASE__
    } catch (err) { /* ignore */ }
    try {
      if (location.protocol === 'http:' || location.protocol === 'https:') return ''
    } catch (err) { /* opaque origin: fall through to the transport hint */ }
    try {
      var transport = window.__DSH_TRANSPORT__
      if (transport && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl) {
        return String(transport.streamBaseUrl).replace(/\/+$/, '')
      }
    } catch (err) { /* ignore */ }
    return ''
  }

  function resolveUrl(url) {
    var value = String(url || '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.indexOf('//') === 0) return value
    return baseUrl() + value
  }

  /* ------------------------------- overlay --------------------------------- */

  /* Build and attach the overlay. Runs while the parser may still be inside
     <head>, so `document.body` can legitimately not exist yet: in that case the
     overlay hangs off <html> (it is position:fixed, so it paints identically)
     and is moved into <body> once the body exists. */
  function build() {
    /* Arm the boot style even if this loader was reached by a path that did not
       set it (a hand-added tag, a test harness), so the first paint is covered. */
    try { document.documentElement.setAttribute('data-dsh-opening-boot', '') } catch (err) { /* ignore */ }

    overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.setAttribute('data-dsh-opening', 'active')
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100%',
      'height:100%',
      'margin:0',
      'padding:0',
      'border:0',
      'background:#0b0b0b',
      'overflow:hidden',
      'z-index:2147483000',
      'opacity:1',
      'pointer-events:auto',
      'transition:opacity ' + Math.max(0, Number(CFG.fadeMs) || 0) + 'ms ease'
    ].join(';')

    frame = document.createElement('iframe')
    frame.id = FRAME_ID
    frame.title = 'DeepSeek Harness opening'
    frame.setAttribute('scrolling', 'no')
    frame.setAttribute('frameborder', '0')
    frame.setAttribute('allowtransparency', 'false')
    frame.style.cssText = 'display:block;width:100%;height:100%;margin:0;padding:0;border:0;background:#0b0b0b'
    /* The token rides along in the URL; the frame echoes it on every message. */
    messageToken = String(Math.random()).slice(2) + String(Date.now())
    var splashUrl = resolveUrl(CFG.splashUrl || '/dsh-opening/splash.html')
    frame.src = splashUrl + (splashUrl.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(messageToken)
    overlay.appendChild(frame)

    /* The hint is opt-in: the default presentation is clean. */
    if (CFG.showSkipHint === true) {
      hint = document.createElement('div')
      hint.id = HINT_ID
      hint.style.cssText = [
        'position:absolute',
        'right:26px',
        'bottom:20px',
        'font:500 13px/1.5 "Cascadia Mono",Consolas,"Courier New",monospace',
        'letter-spacing:.09em',
        'text-transform:uppercase',
        'color:#6f6b66',
        'opacity:0',
        'transition:opacity .8s ease',
        'pointer-events:none',
        'user-select:none',
        'z-index:1'
      ].join(';')
      /* "Esc skip" in Chinese, written as \u escapes so this file stays ASCII. */
      hint.textContent = 'Esc \u8DF3\u8FC7'
      overlay.appendChild(hint)
    }

    mount()
    /* The hint arrives late so the opening reads as a film, not as a dialog. */
    if (hint) {
      hintTimer = setTimeout(function () {
        if (hint) hint.style.opacity = '.72'
      }, Math.min(1800, Math.max(600, (Number(CFG.durationMs) || 20000) / 12)))
    }
  }

  function mount() {
    if (!overlay) return
    var host = document.body || document.documentElement
    if (!host) return
    host.appendChild(overlay)
  }

  function remountWhenBodyExists() {
    if (document.body && overlay && overlay.parentNode !== document.body) {
      try { document.body.appendChild(overlay) } catch (err) { /* keep it where it is */ }
    }
  }

  function on(target, type, handler, options) {
    try {
      target.addEventListener(type, handler, options)
      detach.push(function () { try { target.removeEventListener(type, handler, options) } catch (err) { /* ignore */ } })
    } catch (err) { /* ignore */ }
  }

  /* ------------------------------- skipping -------------------------------- */

  function skip(reason) {
    if (finished) return
    /* Ask the animation to stop itself first, so its own state stays coherent.
       Only reachable same-origin; the frame is removed with the overlay anyway. */
    try {
      var w = frame && frame.contentWindow
      if (w && w.DSHSplash && typeof w.DSHSplash.skip === 'function') w.DSHSplash.skip()
    } catch (err) { /* cross-origin; finish() below still runs */ }
    finish(reason, 'skip')
  }

  function wireSkip() {
    if (CFG.skippable === false) return
    on(window, 'keydown', function (event) {
      if (!event) return
      var key = event.key
      if (key !== 'Escape' && key !== 'Esc' && CFG.skipOnAnyKey !== true) return
      try { event.preventDefault(); event.stopPropagation() } catch (err) { /* ignore */ }
      skip('key')
    }, true)
    /* Click-to-skip is opt-in: by default a stray click at boot must not end the
       opening early. */
    if (CFG.skipOnClick !== true) return
    on(window, 'pointerdown', function (event) {
      try { event.preventDefault(); event.stopPropagation() } catch (err) { /* ignore */ }
      skip('click')
    }, true)
  }

  /* ------------------------------- reporting -------------------------------- */

  /* Tell the host a splash ended and why. This is what makes the plugin
     observable from the outside -- without it, "did it play in the real
     browser?" has no answer the host can read. Diagnostics must never break the
     page, so every failure here is swallowed. */
  function report(reason, via) {
    try {
      var query = '?reason=' + encodeURIComponent(String(reason || 'unknown'))
        + '&stage=loader'
        + '&via=' + encodeURIComponent(String(via || 'unknown'))
        + '&detail=' + encodeURIComponent(frameReady ? 'ready-message' : 'no-ready-message')
        + '&w=' + (window.innerWidth || 0)
        + '&h=' + (window.innerHeight || 0)
        + '&ua=' + encodeURIComponent(String(navigator.userAgent || '').slice(0, 200))
      var url = resolveUrl(PLAYED_PATH) + query
      if (typeof fetch === 'function') {
        fetch(url, { cache: 'no-store', keepalive: true }).catch(function () {})
      } else {
        var beacon = new Image()
        beacon.src = url
      }
    } catch (err) { /* ignore */ }
  }

  /* -------------------------------- finish --------------------------------- */

  /* The boot style keeps the canvas black from the first paint. It must come off
     the moment the splash is gone, or a light theme would keep a black canvas
     behind the app. */
  function clearBootStyle() {
    try { document.documentElement.removeAttribute('data-dsh-opening-boot') } catch (err) { /* ignore */ }
  }

  function finish(reason, via) {
    if (finished) return
    finished = true
    stopTimers()
    for (var i = 0; i < detach.length; i++) detach[i]()
    detach = []
    /* Only a splash that actually played counts against the frequency gates.
       A load failure must not quietly consume the session or the cooldown. */
    if (playbackStarted) markPlayed()
    clearBootStyle()
    report(reason, via || lastArmVia)
    log('finished:', reason, via || lastArmVia)

    var node = overlay
    overlay = null
    frame = null
    hint = null
    if (!node) return

    node.setAttribute('data-dsh-opening', 'done')
    node.style.pointerEvents = 'none'
    node.style.opacity = '0'
    var remove = function () {
      try { if (node.parentNode) node.parentNode.removeChild(node) } catch (err) { /* ignore */ }
    }
    var fade = Math.max(0, Number(CFG.fadeMs) || 0)
    if (fade > 0) setTimeout(remove, fade + 80)
    else remove()

    try {
      window.dispatchEvent(new CustomEvent('dsh:opening-complete', { detail: { reason: reason } }))
    } catch (err) { /* CustomEvent unavailable: nothing to do */ }
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0 }
    if (capTimer) { clearTimeout(capTimer); capTimer = 0 }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = 0 }
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = 0 }
  }

  /* ------------------------------ frame wiring ------------------------------ */

  /* The animation announces itself over postMessage. This is the channel that
     works everywhere: on the Electron shell the iframe is cross-origin (a
     `dsh-app://app/` document hosting assets served from `http://127.0.0.1:<p>`),
     so reading `contentWindow` throws and the parent would otherwise never learn
     that the animation started or ended. Depending on that read is exactly what
     tore an earlier build's overlay down on a timer mid-playback. */
  function wireFrameMessages() {
    on(window, 'message', function (event) {
      if (finished) return
      if (!event) return
      var data = event.data
      if (!data || data.source !== 'dsh-opening-splash') return
      /* The token is the authentication: only the frame we started carries it. */
      if (!messageToken || data.k !== messageToken) return

      if (data.type === 'ready') {
        frameReady = true
        if (Number(data.duration) > 0) frameDuration = Number(data.duration)
        log('animation reported ready', data.duration)
        armFrame(data.duration, 'message')
        return
      }
      if (data.type === 'done') { finish(String(data.reason || 'completed'), 'message'); return }
      if (data.type === 'skip') {
        /* The parent owns the policy; the frame only reports the intent. */
        if (CFG.skippable === false) return
        if (data.how === 'click' && CFG.skipOnClick !== true) return
        skip(data.how === 'click' ? 'click' : 'key')
      }
    })
  }

  /* Same-origin extras, used when the frame is reachable: skipping from inside
     it, and the animation's own completion event read directly. In a browser
     this makes the plugin independent of the served bridge; across origins the
     bridge's messages are the only channel. */
  function wireFrameSameOrigin() {
    try {
      var w = frame.contentWindow
      if (!w || !w.document) return
      var doc = w.document
      if (doc.__dshOpeningSkipWired) return
      doc.__dshOpeningSkipWired = true
      if (CFG.skippable !== false) doc.addEventListener('keydown', function (event) {
        if (!event) return
        if (event.key !== 'Escape' && event.key !== 'Esc' && CFG.skipOnAnyKey !== true) return
        skip('key')
      }, true)
      if (CFG.skippable !== false && CFG.skipOnClick === true) {
        doc.addEventListener('pointerdown', function () { skip('click') }, true)
      }
      if (typeof w.addEventListener === 'function') {
        w.addEventListener('dsh:splash-complete', function (event) {
          finish((event && event.detail && event.detail.reason) || 'completed')
        })
      }
    } catch (err) {
      /* Cross-origin: the bridge's `ready` / `done` / `skip` messages cover
         everything this function would have wired. */
    }
  }

  /* Has the animation inside the frame declared itself finished? The animation
     hides #splash when it is done; that is the observable we trust, with
     window.finished as a secondary signal. Only reachable same-origin. */
  function frameIsDone() {
    try {
      var w = frame.contentWindow
      if (!w) return false
      if (w.finished === true) return true
      var splash = w.document && w.document.getElementById('splash')
      if (splash && (splash.hidden === true || splash.style.display === 'none')) return true
    } catch (err) { /* cross-origin: the `done` message is the signal instead */ }
    return false
  }

  function frameReportsReady() {
    if (frameReady) return true
    try {
      var w = frame.contentWindow
      return !!(w && (w.__splashReady === true || (w.DSHSplash && typeof w.DSHSplash.renderAt === 'function')))
    } catch (err) { return false }
  }

  /* Arm the ending of the splash. Reached from the frame's `load` event (which
     fires cross-origin, and is therefore the one signal always available) and
     again from a `ready` message, which refines the duration.
     `via` records which signal armed it, for the host-side diagnostics. */
  function armFrame(durationHint, via) {
    if (finished) return
    playbackStarted = true
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = 0 }
    lastArmVia = via || lastArmVia || 'load'
    wireFrameSameOrigin()

    var duration = Number(durationHint) || frameDuration || Number(CFG.durationMs) || 0
    var speed = Number(CFG.speed)
    if (isFinite(speed) && speed > 0) duration = duration / speed
    var own = Number(CFG.maxDurationMs) || 0
    /* The animation reports its own runtime; the tail covers the gap between
       that clock and the document having loaded, plus its closing curtain. */
    var endsAt = own > 0 ? own : (duration > 0 ? duration + COMPLETION_TAIL_MS : 0)
    if (endsAt > 0) {
      var proposedDeadline = Date.now() + endsAt
      capDeadline = capDeadline ? Math.min(capDeadline, proposedDeadline) : proposedDeadline
      endsAt = Math.max(0, capDeadline - Date.now())
    }

    if (!capTimer && endsAt > 0) {
      capTimer = setTimeout(function () { if (!finished) finish(own > 0 ? 'capped' : 'completed', 'timer') }, endsAt)
    } else if (capTimer && endsAt > 0) {
      /* A later, more precise duration replaces the earlier estimate, but never
         pushes the ending further out than the coarse one already scheduled. */
      clearTimeout(capTimer)
      capTimer = setTimeout(function () { if (!finished) finish(own > 0 ? 'capped' : 'completed', 'timer') }, endsAt)
    }

    if (!pollTimer) {
      /* Reachable only same-origin; harmless elsewhere. */
      pollTimer = setInterval(function () {
        if (finished) return
        if (frameIsDone()) finish('completed', 'same-origin')
      }, 250)
    }
  }

  /* The frame's document is present. This fires across origins, so it -- not any
     read of `contentWindow` -- is what the splash's lifetime is anchored to. */
  function onFrameLoad() {
    if (finished) return
    if (frameIsDone()) { armFrame(0, 'load'); finish('completed', 'same-origin'); return }
    armFrame(0, frameReady ? 'message' : 'load')
  }

  /* --------------------------------- start --------------------------------- */

  function start(force) {
    if (!force && !shouldPlay()) { finished = true; clearBootStyle(); return }
    playbackStarted = false
    frameReady = false
    frameDuration = 0
    lastArmVia = ''
    capDeadline = 0

    build()
    if (!overlay) return

    /* Registered before the frame can possibly load, so no message is missed. */
    wireFrameMessages()

    /* This watchdog covers one thing only: the document never arriving at all.
       It is deliberately not a "has the animation started?" deadline -- across
       origins nothing else is observable, and treating silence as failure is
       what previously cut the opening short. Once `load` fires, the animation's
       own known runtime governs the ending. */
    var loadTimeout = Number(CFG.loadTimeoutMs) || 6000
    loadTimer = setTimeout(function () {
      if (!finished) finish('load-timeout', 'watchdog')
    }, loadTimeout)

    try {
      frame.addEventListener('load', onFrameLoad)
    } catch (err) {
      /* Very old engines: fall back to polling and the duration alone. */
      pollTimer = setInterval(function () {
        if (finished) return
        if (frameReportsReady() || frameIsDone()) { clearInterval(pollTimer); pollTimer = 0; onFrameLoad() }
      }, 150)
    }

    wireSkip()
    log('overlay mounted, waiting for the animation')
  }

  /* Public handle: lets a user (or a future settings page) replay on demand.
     `play` is intentionally unconditional -- an explicit replay must not be
     refused by `oncePerSession` or `cooldownMs`. */
  window.DSHOpening = {
    play: function () { if (!finished) return false; finished = false; detach = []; start(true); return true },
    skip: function () { skip('api') },
    isPlaying: function () { return !finished },
    config: CFG
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', remountWhenBodyExists)
  } else {
    remountWhenBodyExists()
  }

  start()
})()
