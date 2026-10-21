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
  var VIDEO_ID = 'dsh-opening-video'
  var HINT_ID = 'dsh-opening-hint'
  var PLAYED_PATH = '/dsh-opening/played'
  var SESSION_KEY = 'dsh-opening:session'
  var STORE_KEY = 'dsh-opening:last-played'
  /* Where the Settings page stores the switches the user flipped. This half owns
     the read: it runs at boot, synchronously, before the first paint, while the
     Settings page that writes it may not even be loaded yet.
     Key and field names are a contract with lib/client.js -- keep them in step. */
  var PREFS_KEY = 'dsh-opening-splash:settings'
  /* The animation the user uploaded: a Blob in IndexedDB, because a video is far
     too large for the string store above, plus its description in that store. */
  var UPLOAD_META_KEY = 'dsh-opening-splash:upload'
  var DB_NAME = 'dsh-opening-splash'
  var DB_STORE = 'splash'
  var BLOB_KEY = 'custom'
  /* Slack after the animation's own runtime before the overlay is taken away,
     for the case where nothing inside the frame can be observed. The animation
     fades its curtain in over its last 320 ms, so this stays invisible. */
  var COMPLETION_TAIL_MS = 400
  /* How long the ripple's soft edge takes to settle once its hole has grown. */
  var RIPPLE_SETTLE_MS = 400
  /* The interval a double click is recognised within. Matched to the platform's
     own double-click time closely enough for a gesture, and only ever used to
     hold a single click back when both click and double click are enabled. */
  var DOUBLE_CLICK_MS = 320

  var overlay = null
  var frame = null
  /* The element the reveal's rings are centred on and offset by: the frame for
     the built-in animation, the video for an uploaded one. */
  var openingView = null
  /* The Blob URL of an uploaded animation, revoked the moment it is over. */
  var objectUrl = ''
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
  var identityLabel = window.__DSH_OPENING_IDENTITY__ || null
  var pollTimer = 0
  var capTimer = 0
  var capDeadline = 0
  var loadTimer = 0
  var hintTimer = 0
  var clickTimer = 0
  var rippleTimer = 0
  /* A reveal is running: the animation has been stopped on purpose so the hole
     uncovers a standing screen, and its completion is not the opening's end. */
  var rippleActive = false
  var canvasTimer = 0
  var detach = []

  /* Read the host's painted surface rather than guessing its light/dark hex.
     The boot panel keeps its computed background even while hidden by our
     boot guard, and is available before the main app has finished mounting. */
  function hostCanvasColor() {
    if (typeof window.getComputedStyle !== 'function') return ''
    var root = document.getElementById('root')
    var nodes = [root,
      document.querySelector && document.querySelector('[data-dsh-boot]')]
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue
      try {
        var color = window.getComputedStyle(nodes[i]).backgroundColor
        if (color && color !== 'transparent' && !/^rgba?\([^)]*(?:,|\/)\s*0(?:\.0+)?\)$/.test(color)) return color
      } catch (err) { /* the next surface may still be available */ }
    }
    return ''
  }

  function syncCanvasColor() {
    var color = hostCanvasColor()
    if (!color) return
    if (overlay) overlay.style.backgroundColor = color
    if (openingView) openingView.style.backgroundColor = color
    try { document.documentElement.style.setProperty('--dsh-opening-canvas', color) } catch (err) { /* old DOM */ }
  }

  /* ------------------------- the user's own settings ------------------------ */

  /**
   * Read the switches the Settings page stored.
   *
   * Every failure mode -- no storage, unreadable storage, junk in the slot,
   * a value of the wrong type -- answers "no preferences", which leaves the
   * deployment's config exactly as composed.
   */
  function readPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY)
      if (!raw) return {}
      var parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (err) {
      return {}
    }
  }

  /** Fold the stored switches over the served config. */
  function mergePrefs(prefs) {
    if (!prefs) return
    if (typeof prefs.skipOnDoubleClick === 'boolean') CFG.skipOnDoubleClick = prefs.skipOnDoubleClick
    if (typeof prefs.defaultName === 'boolean') CFG.revertName = prefs.defaultName
    if (typeof prefs.customSplash === 'boolean') CFG.customSplash = prefs.customSplash
  }

  /* ---------------------------- the uploaded animation ---------------------------- */

  /** Is there an uploaded animation to play? */
  function wantsCustomSplash() {
    if (CFG.customSplash !== true) return false
    try {
      var raw = localStorage.getItem(UPLOAD_META_KEY)
      var meta = raw ? JSON.parse(raw) : null
      return Boolean(meta && typeof meta === 'object' && typeof meta.name === 'string')
    } catch (err) {
      return false
    }
  }

  /**
   * The stored Blob, or `null`.
   *
   * IndexedDB is asynchronous, so this is the one step of the boot that cannot
   * be done before the first paint. Everything it can fail at -- no database
   * API, a refused open, a missing record, a corrupt one -- answers `null`, and
   * the caller falls back to the built-in animation.
   */
  function readUploadBlob() {
    return new Promise(function (resolve) {
      var request
      try {
        var factory = window.indexedDB
        if (!factory || typeof factory.open !== 'function') { resolve(null); return }
        request = factory.open(DB_NAME, 1)
      } catch (err) { resolve(null); return }
      request.onupgradeneeded = function () {
        try {
          var db = request.result
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
        } catch (err) { /* the error handler below reports it */ }
      }
      request.onerror = function () { resolve(null) }
      request.onsuccess = function () {
        var db = request.result
        try {
          var get = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(BLOB_KEY)
          get.onsuccess = function () { resolve(get.result || null) }
          get.onerror = function () { resolve(null) }
        } catch (err) { resolve(null) }
      }
    })
  }

  /**
   * A URL for the uploaded Blob, or `''` when the platform refuses one.
   *
   * `window.URL` first, then the bare global: the node shims these tests run on
   * expose the API on the window object rather than as a global, and the two
   * spellings are the same object in a browser.
   */
  function objectUrlApi() {
    try {
      if (window.URL && typeof window.URL.createObjectURL === 'function') return window.URL
    } catch (err) { /* ignore */ }
    try {
      if (typeof URL !== 'undefined' && URL && typeof URL.createObjectURL === 'function') return URL
    } catch (err) { /* ignore */ }
    return null
  }

  /** A URL for the uploaded Blob, or `''` when the platform refuses one. */
  function urlFor(blob) {
    var api = objectUrlApi()
    if (!api) return ''
    try {
      return api.createObjectURL(blob)
    } catch (err) {
      return ''
    }
  }

  /** Release a Blob URL; a leak here pins the whole video in memory. */
  function releaseUrl() {
    if (!objectUrl) return
    var api = objectUrlApi()
    try { if (api) api.revokeObjectURL(objectUrl) } catch (err) { /* ignore */ }
    objectUrl = ''
  }

  /**
   * Play the user's own animation.
   *
   * It is a plain `<video>` in the overlay, so it inherits every gesture the
   * built-in animation has -- Escape, the single and double click, the hint, the
   * watchdog and the ripple reveal -- because all of those are wired on the
   * overlay and this window, not inside the frame. What it does not have is a
   * frame to ask, so its own events supply the ending: `loadeddata` arms the
   * clock from the media duration, `ended` completes it.
   *
   * @returns whether the custom animation was started at all.
   */
  function playCustomSplash() {
    return readUploadBlob().then(function (blob) {
      if (finished) return true
      if (!blob) { log('custom splash: nothing stored'); return false }
      var src = urlFor(blob)
      if (!src) { log('custom splash: no object URL'); return false }

      objectUrl = src
      var video = document.createElement('video')
      video.id = VIDEO_ID
      video.setAttribute('data-dsh-opening-view', 'video')
      video.setAttribute('aria-label', 'DeepSeek Harness opening animation')
      /* Muted is what makes autoplay allowed without a gesture: an opening that
         needs a click to start is not an opening. Uploaded audio is not part of
         the contract, and a muted attribute is the one every engine honours. */
      video.muted = true
      video.defaultMuted = true
      video.setAttribute('muted', '')
      video.playsInline = true
      video.setAttribute('playsinline', '')
      video.autoplay = true
      video.preload = 'auto'
      video.style.cssText = 'display:block;width:100%;height:100%;margin:0;padding:0;'
        + 'border:0;background:#0b0b0b;object-fit:contain;pointer-events:none'
      video.src = src

      overlay.appendChild(video)
      openingView = video
      syncCanvasColor()

      on(video, 'loadeddata', function () {
        if (finished) return
        log('custom splash: media ready', video.duration)
        armFrame(Number(video.duration) > 0 ? Number(video.duration) * 1000 : 0, 'video')
      })
      on(video, 'ended', function () { if (!finished) finish('completed', 'video') })
      /* A codec the engine cannot decode, or a file that stopped mid-read: the
         animation is over, and the page must not be left behind it. */
      on(video, 'error', function () {
        if (finished) return
        log('custom splash: media failed')
        finish('media-error', 'video')
      })

      var playing = video.play()
      if (playing && typeof playing.catch === 'function') {
        /* Autoplay can still be refused (a strict policy, a battery saver). The
           opening then ends rather than holding a black screen. */
        playing.catch(function () {
          if (finished) return
          log('custom splash: autoplay refused')
          finish('autoplay-blocked', 'video')
        })
      }
      log('custom splash: playing the uploaded animation')
      return true
    })
  }

  /**
   * Is the opening showing the animation's own default name?
   *
   * The published label and this flag are two sources for one fact, so they are
   * reconciled in one place: while the flag is on the label is withdrawn, and
   * the animation falls back to `DEEPSEEK` -- which is the whole point of the
   * switch, and what makes it take effect without a reload.
   */
  function applyNamePolicy() {
    var label = CFG.revertName === true ? null : identityLabel
    try { window.__DSH_OPENING_IDENTITY__ = label } catch (err) { /* ignore */ }
    sendIdentity(label)
  }

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
     and is moved into <body> once the body exists.
     `view` picks what fills it: the built-in animation in a frame, or the
     video the user uploaded. */
  function build(view) {
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
    syncCanvasColor()
    canvasTimer = setInterval(syncCanvasColor, 250)

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
        'z-index:2'
      ].join(';')
      /* "Esc skip" / "double click or Esc skip", in Chinese, written as \u escapes
         so this file stays ASCII. The hint names the gesture the user actually
         has, which is the only place it is ever advertised. */
      hint.textContent = CFG.skipOnDoubleClick === true
        ? '\u53cc\u51fb\u6216 Esc \u8DF3\u8FC7'
        : 'Esc \u8DF3\u8FC7'
      overlay.appendChild(hint)
    }

    /* What fills the overlay, and therefore what the reveal is measured
       against: the built-in animation in its frame, or the uploaded video. */
    if (view === 'video') buildVideoView()
    else buildFrameView()

    mount()
    /* The hint arrives late so the opening reads as a film, not as a dialog. */
    if (hint) {
      hintTimer = setTimeout(function () {
        if (hint) hint.style.opacity = '.72'
      }, Math.min(1800, Math.max(600, (Number(CFG.durationMs) || 20000) / 12)))
    }
  }

  /** The built-in animation: this plugin's own page, in a frame. */
  function buildFrameView() {
    frame = document.createElement('iframe')
    frame.id = FRAME_ID
    frame.title = 'DeepSeek Harness opening'
    frame.setAttribute('scrolling', 'no')
    frame.setAttribute('frameborder', '0')
    frame.setAttribute('allowtransparency', 'true')
    /* The animation has no controls. Route clicks to the parent document so
       double click works even when a cross-origin bridge cannot report it. */
    frame.style.cssText = 'display:block;width:100%;height:100%;margin:0;padding:0;border:0;background:#0b0b0b;pointer-events:none'
    /* The token rides along in the URL; the frame echoes it on every message. */
    messageToken = String(Math.random()).slice(2) + String(Date.now())
    var splashUrl = resolveUrl(CFG.splashUrl || '/dsh-opening/splash.html')
    frame.src = splashUrl + (splashUrl.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(messageToken)
    openingView = frame
    overlay.appendChild(frame)
    syncCanvasColor()
  }

  /**
   * The uploaded animation: a video element, added once its Blob is in hand.
   *
   * Nothing is appended here because the Blob arrives asynchronously; the
   * caller appends what `playCustomSplash` builds. `openingView` is set there
   * too, so the reveal has something to centre on.
   */
  function buildVideoView() {
    /* A placeholder would flash before the media appears, so the black overlay
       simply stays until the video is appended. */
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

  /**
   * End the opening.
   *
   * `detail` may carry where a double click landed and whether the reveal is
   * allowed, in which case the overlay is opened up rather than faded out.
   */
  function skip(reason, detail) {
    if (finished) return
    var reveal = detail && detail.ripple === true && CFG.rippleReveal !== false
    /*
     * The animation is told to stop only when the ending will not reveal it.
     * Its own `skip` ends the clip and announces completion, and that
     * announcement is what tears the overlay down -- so asking for it first
     * would finish the opening with the ordinary fade and the reveal would
     * never run. On the reveal path the frame is stopped by the side that
     * knows the reveal is coming (the bridge, same document; or this module's
     * teardown, which takes the overlay away whatever happens next).
     */
    if (!reveal) stopAnimation()
    if (reveal) {
      finishRipple(reason, detail.point)
      return
    }
    finish(reason, 'skip')
  }

  /** Ask the animation to end its own clip, keeping its own state coherent. */
  function stopAnimation() {
    try {
      var w = frame && frame.contentWindow
      if (w && w.DSHSplash && typeof w.DSHSplash.skip === 'function') w.DSHSplash.skip()
    } catch (err) { /* cross-origin; finish() below still runs */ }
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
    if (CFG.skipOnClick === true) {
      on(window, 'pointerdown', function (event) {
        /* With double click also on, the first click of a double click must not
           win: the single click waits out the double-click interval, and a
           second click that lands in time cancels it. Only then can the
           deliberate gesture reach the ripple instead of a plain skip. */
        if (CFG.skipOnDoubleClick !== true) { skip('click'); return }
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; return }
        clickTimer = setTimeout(function () {
          clickTimer = 0
          skip('click')
        }, DOUBLE_CLICK_MS)
      }, true)
    }

    if (CFG.skipOnDoubleClick !== true) return
    /* The parent's own view of the gesture, for both carriers: in a browser the
       frame is same-origin, on the Electron shell it is not and the bridge
       reports instead. Both land here, and a duplicate is dropped by `finished`. */
    on(window, 'dblclick', function (event) {
      var point = null
      try {
        point = { x: Number(event && event.clientX) || 0, y: Number(event && event.clientY) || 0 }
      } catch (err) { /* ignore */ }
      skip('dblclick', { ripple: true, point: point })
    }, true)
  }

  /* ---------------------------- the ripple reveal --------------------------- */

  /**
   * Where the expanding hole is centred.
   *
   * A point reported by the frame is in the frame's own viewport, so the frame's
   * offset on the page is added back; without a point -- the parent's own
   * gesture, or a frame that could not be measured -- the opening is revealed
   * from the middle of the screen.
   */
  function revealPoint(point) {
    var x = window.innerWidth / 2
    var y = window.innerHeight / 2
    if (!point) return { x: x, y: y }
    if (isFinite(point.x) && isFinite(point.y)) {
      x = Number(point.x)
      y = Number(point.y)
      try {
        /* Whichever view is playing reports its own offset: the frame for the
           built-in animation, the video for an uploaded one. */
        var view = openingView || frame
        if (view && typeof view.getBoundingClientRect === 'function') {
          var rect = view.getBoundingClientRect()
          if (rect) { x += Number(rect.left) || 0; y += Number(rect.top) || 0 }
        }
      } catch (err) { /* an unmeasurable view still reveals from the right spot */ }
    }
    return { x: x, y: y }
  }

  /** How far the hole must grow to clear the viewport from a given origin. */
  function revealReach(x, y) {
    var width = window.innerWidth || 1
    var height = window.innerHeight || 1
    var corners = [
      Math.sqrt(x * x + y * y),
      Math.sqrt((width - x) * (width - x) + y * y),
      Math.sqrt(x * x + (height - y) * (height - y)),
      Math.sqrt((width - x) * (width - x) + (height - y) * (height - y))
    ]
    return Math.max(corners[0], corners[1], corners[2], corners[3]) + 8
  }

  /**
   * Is a mask animatable on this engine?
   *
   * Feature-detected rather than assumed: the reveal is a mask, and an engine
   * without one would otherwise be left showing nothing at all until the timer
   * took the overlay away.
   */
  function maskAnimatable() {
    try {
      if (typeof CSS === 'undefined' || !CSS || typeof CSS.supports !== 'function') return false
      return CSS.supports('mask-image', 'radial-gradient(circle at 50% 50%, transparent 0px, #000 1px)')
        || CSS.supports('-webkit-mask-image', 'radial-gradient(circle at 50% 50%, transparent 0px, #000 1px)')
    } catch (err) {
      return false
    }
  }

  /** Set one mask value on both the standard and the prefixed property. */
  function setMask(style, value) {
    try { style.maskImage = value } catch (err) { /* ignore */ }
    try { style.webkitMaskImage = value } catch (err) { /* ignore */ }
  }

  /** One ripple ring: a hairline circle that fades as it travels outward. */
  function rippleRing(x, y, size, duration, delay) {
    var ring = document.createElement('div')
    ring.setAttribute('data-dsh-opening-ripple', 'ring')
    ring.style.cssText = [
      'position:absolute',
      'left:' + x + 'px',
      'top:' + y + 'px',
      'width:' + size + 'px',
      'height:' + size + 'px',
      'margin:0',
      'box-sizing:border-box; border:2px solid rgba(190,225,255,.95);box-shadow:0 0 6px rgba(80,160,255,.45)',
      'border-radius:50%',
      'transform:translate(-50%,-50%) scale(0)',
      'opacity:0',
      'pointer-events:none',
      'will-change:transform,opacity',
      'animation:dsh-opening-ripple ' + duration + 'ms linear ' + delay + 'ms forwards'
    ].join(';')
    return ring
  }

  /* The keyframes ship with the script rather than with the page, so the reveal
     works on a carrier whose stylesheet this plugin does not control. */
  var RIPPLE_KEYFRAMES = '@keyframes dsh-opening-ripple{0%{opacity:0}10%{opacity:.95}55%{opacity:.7}85%{opacity:.25}100%{opacity:0}}'

  function installRippleKeyframes() {
    var id = 'dsh-opening-ripple-keyframes'
    try {
      if (document.getElementById(id)) return
      var tag = document.createElement('style')
      tag.id = id
      tag.textContent = RIPPLE_KEYFRAMES
      var host = document.head || document.documentElement
      if (host) host.appendChild(tag)
    } catch (err) { /* no head to put it in: the reveal falls back to the fade */ }
  }

  /**
   * End the opening by opening it up from where the double click landed.
   *
   * Two water rings travel outward from the point -- the outer one leading, the
   * inner one behind it -- while the splash itself is masked away by a hole that
   * grows from the same origin, so the app underneath is what the hole reveals.
   * The hole's edge keeps a soft shoulder and tightens as it grows, which is
   * what keeps it reading as water rather than as a wipe.
   *
   * Falls back to the ordinary fade whenever the engine cannot animate a mask:
   * a reveal that never reveals would be worse than no reveal.
   */
  function finishRipple(reason, point) {
    if (finished) return
    if (!overlay || !maskAnimatable()) { finish(reason, 'skip'); return }
    /* Keep the clip playing underneath the expanding hole. Removing the iframe
       at the end of the transition disposes its animation with the document. */
    rippleActive = true
    var at = revealPoint(point)
    var playingFrame = frame
    var node = teardown(reason, 'skip')

    var fade = Math.max(0, Number(CFG.fadeMs) || 0)
    var duration = Math.max(120, Number(CFG.rippleMs) || 1800)
    var reach = revealReach(at.x, at.y)

    installRippleKeyframes()
    node.style.transition = 'none'
    node.style.opacity = '1'
    /* Nothing behind the hole may be clicked through the splash. */
    node.style.pointerEvents = 'none'

    /*
     * The hole: transparent from the centre out to `outer`, then the splash.
     * Both stops are radii in pixels, and they grow together -- the whole
     * transparent region spreads while the black ring only ever travels
     * outward, which is what keeps the stop order valid at every frame. The
     * black stop is a short shoulder past the transparent one, so the moving
     * edge stays soft; the shoulder tightens as the hole reaches the edges.
     *
     * `k` is the fraction of the way to `reach`, never a length: mixing the two
     * puts the stops in the wrong order and the gradient renders as if there
     * were no hole at all.
     */
    var stops = function (k) {
      var transparent = reach * k
      /* The soft edge must also start at zero, otherwise a large translucent
         disk appears immediately even though the hole radius is still zero. */
      var shoulder = Math.min(24, transparent * 0.12) * (1 - k)
      return 'rgba(0,0,0,0) ' + transparent.toFixed(4) + 'px,'
        + '#000 ' + (transparent + shoulder).toFixed(4) + 'px'
    }
    var from = 'radial-gradient(circle at ' + at.x + 'px ' + at.y + 'px, ' + stops(0) + ')'
    var to = 'radial-gradient(circle at ' + at.x + 'px ' + at.y + 'px, ' + stops(1) + ')'
    setMask(node.style, from)

    // Keep water rings outside the mask so the reveal does not erase them.
    var waves = document.createElement('div')
    waves.id = 'dsh-opening-ripples'
    waves.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden'
    var delay = 180
    var inner = rippleRing(at.x, at.y, reach * 2, duration, delay)
    var outer = rippleRing(at.x, at.y, reach * 2.3, duration, 0)
    waves.appendChild(inner)
    waves.appendChild(outer)
    document.body.appendChild(waves)
    // Draw actual travelling crests rather than scaling a perfectly round border.
    // One viewport-sized surface avoids allocating giant glowing ring layers.
    var water = document.createElement('canvas')
    var waterContext = null
    var waterScale = Math.min(1.5, window.devicePixelRatio || 1)
    var waterWidth = window.innerWidth || 1
    var waterHeight = window.innerHeight || 1
    try {
      water.width = Math.ceil(waterWidth * waterScale)
      water.height = Math.ceil(waterHeight * waterScale)
      water.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
      waterContext = water.getContext && water.getContext('2d')
      if (waterContext) {
        waterContext.scale(waterScale, waterScale)
        waves.appendChild(water)
      }
    } catch (err) { waterContext = null }
    outer.style.borderColor = 'rgba(185,225,255,.95)'
    outer.style.boxShadow = '0 0 6px rgba(80,160,255,.45)'

    // Gradient images do not interpolate reliably; animate pixel radii instead.
    var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
    var start = null
    var removed = false
    function disposeClip() {
      /* Detaching the document stops both same-origin and cross-origin playback
         without calling skip(), which would hide the picture prematurely. */
      try {
        if (playingFrame && playingFrame.parentNode) playingFrame.parentNode.removeChild(playingFrame)
      } catch (err) { /* final overlay cleanup remains the fallback */ }
      playingFrame = null
    }
    function progress(elapsed) {
      var t = Math.max(0, Math.min(1, elapsed / duration))
      return t * t * (3 - 2 * t)
    }
      function waveOpacity(t) {
        return Math.min(1, t / 0.1) * Math.pow(1 - t, 0.7)
      }

    function paintWave(radius, time, alpha, phase) {
      if (!waterContext || radius <= 0 || alpha <= 0) return
      var amplitude = Math.min(8, radius * 0.065)
      // Bright crest, blue trough and a second fine crest form a water band.
      for (var band = 0; band < 3; band++) {
        var offset = band === 0 ? 0 : (band === 1 ? -7 : 5)
        waterContext.beginPath()
        for (var i = 0; i <= 128; i++) {
          var angle = i * Math.PI * 2 / 128
          var wobble = amplitude * (0.65 * Math.sin(angle * 7 - time * 0.006 + phase)
            + 0.35 * Math.sin(angle * 11 + time * 0.004 + phase))
          var r = Math.max(0, radius + wobble + offset * Math.min(1, radius / 30))
          var x = at.x + Math.cos(angle) * r
          var y = at.y + Math.sin(angle) * r
          if (i === 0) waterContext.moveTo(x, y)
          else waterContext.lineTo(x, y)
        }
        waterContext.closePath()
        waterContext.strokeStyle = band === 1 ? 'rgba(45,125,220,' + alpha * 0.65 + ')'
          : 'rgba(205,240,255,' + alpha * (band === 0 ? 1 : 0.5) + ')'
        waterContext.lineWidth = band === 0 ? 2.8 : (band === 1 ? 4 : 1.2)
        waterContext.stroke()
      }
    }

    function draw(timestamp) {
      if (removed) return
      if (start === null) start = timestamp
      var elapsed = timestamp - start
      var k = progress(elapsed - delay)
      setMask(node.style, 'radial-gradient(circle at ' + at.x + 'px ' + at.y + 'px, ' + stops(k) + ')')
      inner.style.transform = 'translate(-50%,-50%) scale(' + k + ')'
      var outerProgress = progress(elapsed)
      outer.style.transform = 'translate(-50%,-50%) scale(' + outerProgress + ')'
      // Share the frame clock with the mask so a delayed first frame cannot
      // leave CSS opacity ahead of the actual wave expansion.
      inner.style.animation = 'none'
      outer.style.animation = 'none'
      var innerAlpha = waveOpacity(Math.max(0, Math.min(1, (elapsed - delay) / duration)))
      var outerAlpha = waveOpacity(Math.max(0, Math.min(1, elapsed / duration)))
      if (waterContext) {
        inner.style.opacity = '0'
        outer.style.opacity = '0'
        waterContext.clearRect(0, 0, waterWidth, waterHeight)
        paintWave(reach * k, elapsed, innerAlpha, 0)
        // Keep the leading wave near the inner one, visible longer on screen.
        paintWave(reach * 1.08 * outerProgress, elapsed, outerAlpha, 1.7)
      } else {
        inner.style.opacity = String(innerAlpha)
        outer.style.opacity = String(outerAlpha)
        var bend = 50 + 3 * Math.sin(elapsed * 0.008)
        inner.style.borderRadius = bend + '% ' + (100 - bend) + '%'
        outer.style.borderRadius = (100 - bend) + '% ' + bend + '%'
      }
      if (elapsed < duration + delay) raf(draw)
      else disposeClip()
    }
    if (raf) raf(draw)
    else { setMask(node.style, to); disposeClip() }

    rippleTimer = setTimeout(function () {
      rippleTimer = 0
      removed = true
      disposeClip()
      try { if (waves.parentNode) waves.parentNode.removeChild(waves) } catch (err) { /* ignore */ }
      try { if (node.parentNode) node.parentNode.removeChild(node) } catch (err) { /* ignore */ }
    }, duration + delay + RIPPLE_SETTLE_MS + fade)
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

  /**
   * Everything both endings do, in one place: stop the clocks, drop the
   * listeners, count the playback, take the boot style off the canvas, and
   * announce the ending.
   *
   * The boot style keeps the canvas black from the first paint, so it must come
   * off as soon as the splash is over -- a light theme would otherwise keep a
   * black canvas behind the app. `finishRipple` calls this first and then keeps
   * the node itself around for the reveal.
   *
   * The announcement belongs here rather than in `finish`, because it is part
   * of "the opening is over", not part of "the overlay fades out": a caller
   * waiting on `dsh:opening-complete` would otherwise wait forever whenever the
   * reveal was the ending.
   *
   * @returns the overlay node, already detached from this module's state.
   */
  function teardown(reason, via) {
    finished = true
    clearInterval(canvasTimer)
    canvasTimer = 0
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
    openingView = null
    hint = null
    /* The uploaded animation's Blob URL is released with the play that made it:
       holding one pins the whole file in memory for the life of the page. */
    releaseUrl()

    try {
      window.dispatchEvent(new CustomEvent('dsh:opening-complete', { detail: { reason: reason } }))
    } catch (err) { /* CustomEvent unavailable: nothing to do */ }

    return node
  }

  function finish(reason, via) {
    if (finished) return
    var node = teardown(reason, via)
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
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0 }
    if (capTimer) { clearTimeout(capTimer); capTimer = 0 }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = 0 }
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = 0 }
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0 }
    /* The ripple's own timer is deliberately not cleared here: it removes a node
       that is no longer reachable from this module, and the page it reveals must
       not be left under an overlay that nothing will ever take away. */
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
        applyNamePolicy()
        sendPrefs()
        frameReady = true
        if (Number(data.duration) > 0) frameDuration = Number(data.duration)
        log('animation reported ready', data.duration)
        armFrame(data.duration, 'message')
        return
      }
      if (data.type === 'done') {
        /* A reveal in progress means the bridge stopped the animation to uncover
           a standing screen; that completion is not the end of the opening, and
           the reveal's own timer is what takes the overlay away. */
        if (rippleActive) return
        finish(String(data.reason || 'completed'), 'message')
        return
      }
      if (data.type === 'skip') {
        /* The parent owns the policy; the frame only reports the intent. */
        if (CFG.skippable === false) return
        if (data.how === 'click' && CFG.skipOnClick !== true) return
        if (data.how === 'dblclick') {
          /* Two channels can report the same gesture on a same-origin frame --
             the bridge's message and this window's own listener -- and the first
             one to arrive ends the opening. */
          if (CFG.skipOnDoubleClick !== true || finished) return
          skip('dblclick', { ripple: true, point: data.point })
          return
        }
        skip(data.how === 'click' ? 'click' : 'key')
      }
    })
  }

  /**
   * The origin a message to the animation is addressed to.
   *
   * `frame.src` is what carries the plugin's own route, so it is the honest
   * base. A document without a readable `href` must not be allowed to throw
   * here: that throw would be swallowed as "the account was unavailable" and
   * the name would silently never arrive.
   */
  function frameTargetOrigin() {
    try {
      return new URL(frame.src, location.href).origin
    } catch (err) {
      return '*'
    }
  }

  /**
   * Tell the frame which of the user's switches are on.
   *
   * The frame cannot read them: it is served by the host and, on the Electron
   * shell, lives on another origin from the page that owns the storage. So the
   * gesture wiring inside the animation document -- which the host builds from
   * its own config at serve time -- is reconciled from here, where the switches
   * actually are. `false` is sent as plainly as `true`, so turning a switch off
   * takes effect on the next play without a reload.
   *
   * A deployment that already wired the gesture keeps it: the bridge only ever
   * adds a listener, never removes one.
   */
  function sendPrefs() {
    try {
      if (frame && frame.contentWindow) frame.contentWindow.postMessage({
        source: 'dsh-opening-parent', type: 'prefs', k: messageToken,
        prefs: {
          skipOnClick: CFG.skipOnClick === true,
          skipOnDoubleClick: CFG.skipOnDoubleClick === true,
          skipOnAnyKey: CFG.skipOnAnyKey === true
        }
      }, frameTargetOrigin())
    } catch (err) { /* A frame that cannot be told keeps the host's own wiring. */ }
  }
  /**
   * Publish the name the animation shows after `ID CONFIRMED :`.
   *
   * A deployment that composes `revertName: true` never lets a name through,
   * so the animation keeps its own `DEEPSEEK` and no account data reaches the
   * frame at all.
   */
  function sendIdentity(label) {
    if (label === undefined) label = identityLabel
    if (CFG.revertName === true) label = null
    try {
      if (frame && frame.contentWindow) frame.contentWindow.postMessage({
        source: 'dsh-opening-parent', type: 'identity', k: messageToken,
        label: label
      }, frameTargetOrigin())
    } catch (err) { /* An unavailable account must not interrupt playback. */ }
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
        doc.addEventListener('pointerdown', function () {
          if (CFG.skipOnDoubleClick === true) return
          skip('click')
        }, true)
      }
      if (CFG.skippable !== false && CFG.skipOnDoubleClick === true) {
        doc.addEventListener('dblclick', function (event) {
          var point = null
          try { point = { x: Number(event && event.clientX) || 0, y: Number(event && event.clientY) || 0 } } catch (err) { /* ignore */ }
          skip('dblclick', { ripple: true, point: point })
        }, true)
      }
      if (typeof w.addEventListener === 'function') {
        w.addEventListener('dsh:splash-complete', function (event) {
          /* Same rule as the bridge's `done` message: a reveal stopped the
             animation itself, so this completion is not the opening's end. */
          if (rippleActive) return
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
    sendIdentity()
    if (frameIsDone()) { armFrame(0, 'load'); finish('completed', 'same-origin'); return }
    armFrame(0, frameReady ? 'message' : 'load')
  }

  /* --------------------------------- start --------------------------------- */

  function start(force) {
    /* The switches are re-read per play: a replay from the Settings page picks up
       a change made since the page loaded. */
    mergePrefs(readPrefs())
    if (!force && !shouldPlay()) { finished = true; clearBootStyle(); return }
    playbackStarted = false
    frameReady = false
    frameDuration = 0
    lastArmVia = ''
    capDeadline = 0

    /*
     * The uploaded animation is a Blob, and reading it is asynchronous -- the
     * only step of the boot that cannot be done before the first paint. The
     * overlay is raised either way, so nothing flashes through while the
     * database is read; if the read comes back empty the built-in animation is
     * mounted instead, which is the honest fallback for "the file is gone".
     */
    var custom = wantsCustomSplash()
    build(custom ? 'video' : 'frame')
    if (!overlay) return

    if (!custom) { armOpening(); return }
    playCustomSplash().then(function (started) {
      if (finished) return
      if (started) {
        /* The gestures are wired whichever animation is in the overlay: that is
           what makes Escape, the single click and the double click with its
           ripple work on an uploaded file exactly as they do on the built-in
           one. Wiring happens after the media is mounted, because the reveal is
           centred on it. */
        armOpening()
        return
      }
      log('custom splash unavailable; playing the built-in opening')
      buildFrameView()
      armOpening()
    }).catch(function () {
      if (finished) return
      buildFrameView()
      armOpening()
    })
  }

  /** Wire the ending of whichever animation is now in the overlay. */
  function armOpening() {
    if (finished || !overlay) return

    /* Registered before the frame can possibly load, so no message is missed.
       An uploaded video has no frame to hear from, and posting into a null one
       is already guarded, so this stays unconditional. */
    wireFrameMessages()

    /* This watchdog covers one thing only: the animation never arriving at all.
       It is deliberately not a "has the animation started?" deadline -- across
       origins nothing else is observable, and treating silence as failure is
       what previously cut the opening short. Once `load` fires, the animation's
       own known runtime governs the ending. */
    var loadTimeout = Number(CFG.loadTimeoutMs) || 6000
    loadTimer = setTimeout(function () {
      if (!finished) finish('load-timeout', 'watchdog')
    }, loadTimeout)

    if (frame) {
      try {
        frame.addEventListener('load', onFrameLoad)
      } catch (err) {
        /* Very old engines: fall back to polling and the duration alone. */
        pollTimer = setInterval(function () {
          if (finished) return
          if (frameReportsReady() || frameIsDone()) { clearInterval(pollTimer); pollTimer = 0; onFrameLoad() }
        }, 150)
      }
    }

    wireSkip()
    log('overlay mounted, waiting for the animation')
  }

  /* Public handle: lets a user (or the Settings page) replay on demand.
     `play` is intentionally unconditional -- an explicit replay must not be
     refused by `oncePerSession` or `cooldownMs`. */
  window.DSHOpening = {
    setIdentity: function (label) {
      identityLabel = typeof label === 'string' ? label : null
      applyNamePolicy()
    },
    /* Where the Settings page pushes a switch it just wrote, so the change lands
       on the running page instead of waiting for the next load. */
    setPrefs: function (prefs) {
      mergePrefs(prefs)
      applyNamePolicy()
      sendPrefs()
    },
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
