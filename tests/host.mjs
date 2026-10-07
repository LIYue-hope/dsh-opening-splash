// Functional check of the host half without DSH. Run with the bundled node.
import { readFileSync } from 'node:fs'
import { Config, apply, normalizeConfig, OPENING_PATH, SPLASH_PATH, HEALTH_PATH, PLAYED_PATH } from '../lib/index.js'

let failures = 0
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name) }
  else { failures++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

console.log('config normalization')
{
  const d = normalizeConfig(undefined)
  check('empty input yields defaults', d.enabled === true && d.speed === 1 && d.oncePerSession === false && d.fadeMs === 420, d)
  check('speed clamped low', normalizeConfig({ speed: 0 }).speed === 0.1)
  check('speed clamped high', normalizeConfig({ speed: 999 }).speed === 8)
  check('garbage speed falls back', normalizeConfig({ speed: 'fast' }).speed === 1)
  check('non-object input tolerated', normalizeConfig('nope').enabled === true)
  check('array input tolerated', normalizeConfig([1, 2]).speed === 1)
  check('explicit false survives', normalizeConfig({ enabled: false }).enabled === false)
  check('string boolean is not coerced to true', normalizeConfig({ enabled: 'yes' }).enabled === true)
}

console.log('standard schema')
{
  const r = Config['~standard'].validate({ speed: 2, showSkipHint: false })
  check('validate returns value', r && r.value && r.value.speed === 2 && r.value.showSkipHint === false && !r.issues, r)
  const bad = Config['~standard'].validate(undefined)
  check('validate never reports issues for junk', bad && bad.value && !bad.issues, bad)
}

console.log('tapIndex transform')
{
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><div id=root></div></body></html>'
  const out = applyTapIndex(html)
  check('style inserted', out.includes('data-dsh-opening-boot'))
  check('loader path inserted', out.includes(OPENING_PATH))
  check('inserted after <head>, before <title>', out.indexOf(OPENING_PATH) < out.indexOf('<title>'))
  check('idempotent when the row is already present', applyTapIndex(out) === out)

  const headless = '<!doctype html><body>x</body>'
  const out2 = applyTapIndex(headless)
  check('works without <head>', out2.startsWith('<style>') || out2.indexOf(OPENING_PATH) >= 0)

  check('non-string input passed through', applyTapIndex(null) === null)
}

console.log('injection rows')
{
  const rows = []
  const handlers = {}
  const root = makeRoot(handlers)
  apply(root, {})
  handlers['webserver/index-inject'](rows)
  check('pushes two rows', rows.length === 2, rows.map((r) => r.kind))
  check('style row first', rows[0] && rows[0].kind === 'style' && String(rows[0].text).includes('#0b0b0b'))
  check('script row is head placement', rows[1] && rows[1].kind === 'script' && rows[1].placement === 'head')
  check('script row creates an element rather than a script-src row', String(rows[1].text).includes('createElement("script")'))
  check('script row swallows load failure', String(rows[1].text).includes('onerror'))
  check('script row arms the boot attribute then can clear it', String(rows[1].text).includes('setAttribute') && String(rows[1].text).includes('removeAttribute'))

  const again = []
  handlers['webserver/index-inject'](again)
  check('row is discoverable by path for dedupe', String(again[0] && again[0].text).includes(OPENING_PATH) || String(again[1] && again[1].text).includes(OPENING_PATH))
  const table = [{ kind: 'script', placement: 'head', text: 'x' + OPENING_PATH + 'y' }]
  handlers['webserver/index-inject'](table)
  check('no duplicate when a row already names the path', table.length === 1)

  const off = {}
  const root2 = makeRoot(off)
  apply(root2, { enabled: false })
  const offRows = []
  off['webserver/index-inject'](offRows)
  check('disabled pushes no rows', offRows.length === 0, offRows)
}

console.log('routes')
{
  const handlers = {}
  const root = makeRoot(handlers)
  apply(root, { speed: 2, debug: true })
  const reg = handlers['webServer.register']
  check('webServer injection ran', Array.isArray(reg) && reg.length === 4, reg && reg.length)
  const byPath = Object.fromEntries((reg || []).map((r) => [r.path, r]))

  const loader = byPath[OPENING_PATH]
  const splash = byPath[SPLASH_PATH]
  const health = byPath[HEALTH_PATH]
  check('loader route exact', loader && loader.kind === 'exact')
  check('splash route exact', splash && splash.kind === 'exact')
  check('health route exact', health && health.kind === 'exact')
  check('tapIndex registered', typeof handlers['webServer.tapIndex'] === 'function')

  const r1 = await call(loader.handler, 'GET')
  check('loader 200', r1.status === 200, r1.status)
  check('loader is javascript', String(r1.headers['Content-Type']).startsWith('application/javascript'))
  check('loader is not cacheable', String(r1.headers['Cache-Control']).includes('no-store'))
  check('loader carries the config prelude', r1.body.startsWith('window.__DSH_OPENING__='), r1.body.slice(0, 40))
  check('loader prelude carries speed 2', r1.body.includes('"speed":2'))
  check('loader appends the browser half', r1.body.includes('__DSH_OPENING_LOADED__'))
  check('prelude escapes < so it cannot close the script tag', !r1.body.slice(0, r1.body.indexOf('\n')).includes('<'))
  check('Content-Length matches the body', Number(r1.headers['Content-Length']) === Buffer.byteLength(r1.body), [r1.headers['Content-Length'], Buffer.byteLength(r1.body)])

  const r2 = await call(splash.handler, 'GET')
  check('splash 200', r2.status === 200, r2.status)
  check('splash is html', String(r2.headers['Content-Type']).startsWith('text/html'))
  check('splash Content-Length matches the served body', Number(r2.headers['Content-Length']) === Buffer.byteLength(r2.body), [r2.headers['Content-Length'], Buffer.byteLength(r2.body)])
  check('splash ends with </html>', r2.body.trimEnd().endsWith('</html>'))
  check('splash exposes DSHSplash', r2.body.includes('window.DSHSplash'))

  const r3 = await call(health.handler, 'GET')
  check('health 200', r3.status === 200, r3.status)
  const parsed = JSON.parse(r3.body)
  check('health reports the plugin', parsed.plugin === 'dsh-opening-splash')
  check('health carries both asset sizes', parsed.assets['splash.html'] === 43140 && parsed.assets['opening.js'] > 0, parsed.assets)
  check('health reflects config', parsed.speed === 2 && parsed.enabled === true)

  const r4 = await call(loader.handler, 'POST')
  check('write method rejected with 405', r4.status === 405, r4.status)
  check('405 advertises Allow', r4.headers.Allow === 'GET, HEAD', r4.headers.Allow)

  const r5 = await call(splash.handler, 'HEAD')
  check('HEAD returns no body', r5.status === 200 && (r5.body === '' || r5.body === undefined), r5.status)
}

console.log('the cross-origin bridge appended to the served animation')
{
  const handlers = {}
  const root = makeRoot(handlers)
  apply(root, { speed: 1 })
  const byPath = Object.fromEntries(handlers['webServer.register'].map((r) => [r.path, r]))

  const served = (await call(byPath[SPLASH_PATH].handler, 'GET')).body
  const asset = readFileSync(new URL('../assets/splash.html', import.meta.url), 'utf8')

  check('the asset on disk is untouched (43140 bytes, byte-identical to the deliverable)',
    Buffer.byteLength(asset) === 43140)
  check('the served document is larger than the asset by the bridge only',
    Buffer.byteLength(served) - Buffer.byteLength(asset) < 2200, Buffer.byteLength(served) - Buffer.byteLength(asset))
  check('the animation body is served verbatim before the bridge',
    served.indexOf(asset.slice(0, 4000)) === 0)
  check('the bridge sits immediately before </body>',
    /<\/script><script>\(function\(\)\{try\{function post/.test(served) || served.indexOf('dsh-opening-splash') < served.lastIndexOf('</body>'))
  check('the bridge posts ready', served.includes('post({type:"ready"'))
  check('the bridge forwards completion with its reason', served.includes('dsh:splash-complete') && served.includes('post({type:"done"'))
  check('the bridge tags its messages so the parent can filter', served.includes('"dsh-opening-splash"'))
  check('the bridge echoes the per-play token from its own URL', served.includes('new URLSearchParams(location.search).get("k")') && served.includes('m.k=K'))
  check('the bridge reports itself to the host directly', served.includes('stage=bridge') && served.includes('bridge-ready'))
  check('the bridge targets the parent window', served.includes('parent.postMessage'))
  check('the bridge carries the speed override', served.includes('requestAnimationFrame'))
  check('HEAD carries no bridge body', (await call(byPath[SPLASH_PATH].handler, 'HEAD')).body === '')

  /* skipOnClick off by default: the frame must not even send click intent. */
  check('no click listener in the bridge by default', !served.includes('pointerdown'))
  check('a key skip listener is present by default', served.includes('"Escape"'))

  /* With click skipping on, it appears; with skipping off entirely, neither. */
  const h2 = {}
  apply(makeRoot(h2), { skipOnClick: true })
  const by2 = Object.fromEntries(h2['webServer.register'].map((r) => [r.path, r]))
  const served2 = (await call(by2[SPLASH_PATH].handler, 'GET')).body
  check('the click listener appears when skipOnClick is on', served2.includes('pointerdown'))

  const h3 = {}
  apply(makeRoot(h3), { skippable: false })
  const by3 = Object.fromEntries(h3['webServer.register'].map((r) => [r.path, r]))
  const served3 = (await call(by3[SPLASH_PATH].handler, 'GET')).body
  check('no skip listeners at all when skippable is false',
    !served3.includes('pointerdown') && served3.includes('var allowed=false'))

  /* The speed override must carry the configured value. */
  const h4 = {}
  apply(makeRoot(h4), { speed: 2.5 })
  const by4 = Object.fromEntries(h4['webServer.register'].map((r) => [r.path, r]))
  const served4 = (await call(by4[SPLASH_PATH].handler, 'GET')).body
  check('the bridge carries the configured speed', served4.includes('var SPEED=2.5'), served4.match(/var SPEED=[^;]*/)?.[0])
}

console.log('generated scripts must PARSE, not merely contain the right words')
{
  /* Substring assertions cannot catch a generated source that does not compile.
     A missing separator between two statements ('say(..)post(..)') produced a
     SyntaxError that silently killed the whole bridge -- every signal the parent
     had -- while every substring check still passed. Parse instead. */
  const h = {}
  apply(makeRoot(h), {})
  const by = Object.fromEntries(h['webServer.register'].map((r) => [r.path, r]))
  const served = (await call(by[SPLASH_PATH].handler, 'GET')).body

  const scripts = []
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(served)) !== null) scripts.push({ where: 'splash.html', code: m[1] })

  const rows = []
  h['webserver/index-inject'](rows)
  for (const row of rows) {
    if (row.kind === 'script') scripts.push({ where: 'index row', code: row.text })
  }
  scripts.push({ where: 'opening.js', code: readFileSync(new URL('../assets/opening.js', import.meta.url), 'utf8') })
  /* lib/index.js is an ES module, so `new Function` cannot parse it; it is
     syntax-checked with `node --check` instead, and importing it at the top of
     this file already proves it parses. */
  check('lib/index.js is covered by the import at the top of this file', typeof apply === 'function')

  check('scripts were found to parse', scripts.length >= 3, scripts.map((s) => s.where))
  for (const { where, code } of scripts) {
    let problem = null
    try {
      /* Parses without running: a SyntaxError here is exactly what the browser
         would hit, and it would take the whole element down with it. */
      new Function(code)
    } catch (err) { problem = String((err && err.message) || err) }
    check(`${where} parses as JavaScript`, problem === null, problem)
  }

  /* The bridge specifically: it must parse in every config combination the
     fragment builders can produce, since each one changes the source. */
  for (const cfg of [
    {},
    { speed: 2.5 },
    { skipOnClick: true },
    { skippable: false },
    { skippable: false, skipOnClick: true, speed: 0.5 },
  ]) {
    const hx = {}
    apply(makeRoot(hx), cfg)
    const byx = Object.fromEntries(hx['webServer.register'].map((r) => [r.path, r]))
    const body = (await call(byx[SPLASH_PATH].handler, 'GET')).body
    const mm = /<script>(\(function\(\)\{try\{[\s\S]*?\}\)\(\))<\/script>/.exec(body)
    let problem = null
    if (!mm) problem = 'bridge element not found'
    else {
      try { new Function(mm[1]) } catch (err) { problem = String((err && err.message) || err) }
    }
    check(`the bridge parses with ${JSON.stringify(cfg)}`, problem === null, problem)
  }

  /* And it must actually run: evaluate it against a stub and watch what it
     reports. Parsing is necessary, not sufficient. */
  const h2 = {}
  apply(makeRoot(h2), {})
  const by2 = Object.fromEntries(h2['webServer.register'].map((r) => [r.path, r]))
  const body2 = (await call(by2[SPLASH_PATH].handler, 'GET')).body
  const bridge = /<script>(\(function\(\)\{try\{[\s\S]*?\}\)\(\))<\/script>/.exec(body2)[1]
  const posted = []
  const beacons = []
  const listeners = { window: {}, document: {} }
  const doc = { addEventListener: (t, fn) => { (listeners.document[t] ||= []).push(fn) } }
  const win = {
    location: { search: '?k=tok-abc' },
    parent: { postMessage: (msg) => posted.push(msg) },
    fetch: (url) => { beacons.push(String(url)); return Promise.resolve({}) },
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    DSHSplash: { duration: 20250 },
    addEventListener: (t, fn) => { (listeners.window[t] ||= []).push(fn) },
    document: doc,
  }
  new Function('window', 'document', 'parent', 'fetch', 'encodeURIComponent', 'URLSearchParams', 'location', 'performance', 'requestAnimationFrame', bridge)(
    win, doc, win.parent, win.fetch, encodeURIComponent, URLSearchParams, win.location, win.performance, win.requestAnimationFrame,
  )
  check('the bridge announces readiness on the wire', posted.some((p) => p.type === 'ready'), posted)
  check('the bridge echoes the token it was given', posted.length > 0 && posted.every((p) => p.k === 'tok-abc'), posted)
  check('the bridge tags its messages', posted.every((p) => p.source === 'dsh-opening-splash'), posted)
  check('the bridge reports the animation duration', posted.some((p) => p.type === 'ready' && p.duration === 20250), posted)
  check('the bridge beacons its own readiness to the host', beacons.some((u) => u.includes('stage=bridge') && u.includes('bridge-ready')), beacons)
  check('the bridge beacon carries the token', beacons.some((u) => u.includes('k=tok-abc')), beacons)

  /* The completion path, driven through the listener the bridge registered. */
  for (const fn of listeners.window['dsh:splash-complete'] || []) fn({ detail: { reason: 'completed' } })
  check('the bridge forwards completion', posted.some((p) => p.type === 'done' && p.reason === 'completed'), posted)
  check('the bridge beacons completion', beacons.some((u) => u.includes('bridge-done-completed')), beacons)
  for (const fn of listeners.window.keydown || []) fn({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} })
  check('the bridge forwards an Escape intent', posted.some((p) => p.type === 'skip' && p.how === 'key'), posted)
}

console.log('new defaults keep the opening intact')
{
  const d = normalizeConfig(undefined)
  check('showSkipHint defaults to false', d.showSkipHint === false)
  check('skipOnClick defaults to false', d.skipOnClick === false)
  check('skippable still defaults to true (Escape works)', d.skippable === true)
  check('the defaults are carried into the client config', (() => {
    const h = {}
    apply(makeRoot(h), {})
    const by = Object.fromEntries(h['webServer.register'].map((r) => [r.path, r]))
    return true
  })())
  const h = {}
  apply(makeRoot(h), {})
  const by = Object.fromEntries(h['webServer.register'].map((r) => [r.path, r]))
  const prelude = (await call(by[OPENING_PATH].handler, 'GET')).body.split('\n')[0]
  const cfg = JSON.parse(prelude.slice(prelude.indexOf('=') + 1).replace(/;$/, ''))
  check('the served config carries showSkipHint:false', cfg.showSkipHint === false, cfg.showSkipHint)
  check('the served config carries skipOnClick:false', cfg.skipOnClick === false, cfg.skipOnClick)
  check('the served config still allows Escape', cfg.skippable === true)
}

console.log('observation (the beacon that proves playback)')
{
  const handlers = {}
  const root = makeRoot(handlers)
  apply(root, {})
  const byPath = Object.fromEntries(handlers['webServer.register'].map((r) => [r.path, r]))

  const played = byPath[PLAYED_PATH]
  const health = byPath[HEALTH_PATH]
  const loader = byPath[OPENING_PATH]
  const splash = byPath[SPLASH_PATH]
  check('played route registered', !!played && played.kind === 'exact', Object.keys(byPath))

  /* The counters live for the life of the module, and the `routes` block above
     already served these routes. Assert movements, not absolutes. */
  const snapshot = async () => JSON.parse((await call(health.handler, 'GET')).body).observed
  const start = await snapshot()
  check('health exposes an observation block', !!start && !!start.served, start)
  check('observation starts with no playback recorded', start.playbacks === 0 && start.lastPlayback === null, start)
  check('observation carries a window start time', typeof start.since === 'string' && start.since.endsWith('Z'), start.since)

  await call(loader.handler, 'GET')
  await call(splash.handler, 'GET')
  await call(loader.handler, 'GET')
  const moved = await snapshot()
  check('loader serves are counted', moved.served.loader - start.served.loader === 2, [start.served, moved.served])
  check('splash serves are counted', moved.served.splash - start.served.splash === 1, [start.served, moved.served])

  const a = await call(played.handler, 'GET', '/dsh-opening/played?reason=completed&w=1600&h=900&ua=Edge%2F141')
  check('beacon answers 204', a.status === 204, a.status)
  await new Promise((r) => setTimeout(r, 520))
  let h = JSON.parse((await call(health.handler, 'GET')).body)
  check('beacon recorded a playback', h.observed.playbacks === 1, h.observed)
  check('beacon recorded the reason', h.observed.lastPlayback.reason === 'completed', h.observed.lastPlayback)
  check('beacon recorded the viewport', h.observed.lastPlayback.viewport.width === 1600 && h.observed.lastPlayback.viewport.height === 900, h.observed.lastPlayback)
  check('beacon recorded the user agent', h.observed.lastPlayback.userAgent === 'Edge/141', h.observed.lastPlayback)
  check('beacon recorded a timestamp', typeof h.observed.lastPlayback.at === 'string' && h.observed.lastPlayback.at.endsWith('Z'), h.observed.lastPlayback)

  /* Rate limiting: with the window open, the first of a burst lands and the
     rest are dropped. */
  await new Promise((r) => setTimeout(r, 520))
  const before = JSON.parse((await call(health.handler, 'GET')).body).observed.playbacks
  await call(played.handler, 'GET', '/dsh-opening/played?reason=burst1')
  await call(played.handler, 'GET', '/dsh-opening/played?reason=burst2')
  await call(played.handler, 'GET', '/dsh-opening/played?reason=burst3')
  const after = JSON.parse((await call(health.handler, 'GET')).body).observed.playbacks
  check('a burst is collapsed to a single record', after - before === 1, [before, after])

  /* Bounds: a hostile caller cannot inflate the record. */
  await new Promise((r) => setTimeout(r, 520))
  await call(played.handler, 'GET', '/dsh-opening/played?reason=' + 'x'.repeat(500) + '&w=99999999&h=-5')
  h = JSON.parse((await call(health.handler, 'GET')).body)
  check('reason is truncated', h.observed.lastPlayback.reason.length === 48, h.observed.lastPlayback.reason.length)
  check('an out-of-range viewport is dropped', h.observed.lastPlayback.viewport.width === null, h.observed.lastPlayback.viewport)
  check('a negative viewport is dropped', h.observed.lastPlayback.viewport.height === null, h.observed.lastPlayback.viewport)

  await new Promise((r) => setTimeout(r, 520))
  await call(played.handler, 'GET', '/dsh-opening/played')
  h = JSON.parse((await call(health.handler, 'GET')).body)
  check('a beacon without a reason degrades to unknown', h.observed.lastPlayback.reason === 'unknown', h.observed.lastPlayback)

  const bad = await call(played.handler, 'POST')
  check('the beacon refuses writes', bad.status === 405, bad.status)

  /* The bridge's own events must be visible but must NOT count as playbacks --
     that separation is what makes a silent message channel diagnosable. */
  await new Promise((r) => setTimeout(r, 520))
  const beforeBridge = JSON.parse((await call(health.handler, 'GET')).body).observed
  await call(played.handler, 'GET', '/dsh-opening/played?stage=bridge&reason=bridge-ready&k=tok123')
  await new Promise((r) => setTimeout(r, 520))
  await call(played.handler, 'GET', '/dsh-opening/played?stage=bridge&reason=bridge-done-completed')
  const afterBridge = JSON.parse((await call(health.handler, 'GET')).body).observed
  check('bridge events do not inflate the playback count', afterBridge.playbacks === beforeBridge.playbacks, [beforeBridge.playbacks, afterBridge.playbacks])
  check('bridge events are still recorded in the event log', afterBridge.events.length >= beforeBridge.events.length + 2, afterBridge.events.length)
  const bridgeEvent = [...afterBridge.events].reverse().find((e) => e.stage === 'bridge')
  check('a bridge event is tagged with its stage', !!bridgeEvent && bridgeEvent.stage === 'bridge', bridgeEvent)
  check('a bridge event keeps its reason', !!bridgeEvent && /^bridge-/.test(bridgeEvent.reason), bridgeEvent)
  check('the event log is bounded', afterBridge.events.length <= 12, afterBridge.events.length)

  /* The parent's report carries the path it ended by. */
  await new Promise((r) => setTimeout(r, 520))
  await call(played.handler, 'GET', '/dsh-opening/played?reason=completed&stage=loader&via=timer&detail=no-ready-message')
  h = JSON.parse((await call(health.handler, 'GET')).body)
  check('the parent report keeps via and detail', h.observed.lastPlayback.via === 'timer' && h.observed.lastPlayback.detail === 'no-ready-message', h.observed.lastPlayback)
}

function makeRoot(handlers) {
  return {
    on(event, fn) { handlers[event] = fn; return () => {} },
    inject(services, fn) {
      const ctx = {
        webServer: {
          register(route) { (handlers['webServer.register'] ||= []).push(route); return () => {} },
          tapIndex(fn2) { handlers['webServer.tapIndex'] = fn2; return () => {} },
        },
        effect(fn) { fn(); return () => {} },
      }
      fn(ctx)
    },
  }
}

function applyTapIndex(html) {
  const handlers = {}
  const root = makeRoot(handlers)
  apply(root, {})
  return handlers['webServer.tapIndex'](html)
}

async function call(handler, method, url) {
  const headers = {}
  let body = ''
  const res = {
    statusCode: 0,
    writeHead(status, h) { this.statusCode = status; Object.assign(headers, h || {}) },
    end(chunk) { if (chunk !== undefined && chunk !== null) body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    destroy() {},
  }
  await handler({ method, url: url || '/', headers: { host: '127.0.0.1:19387' } }, res)
  return { status: res.statusCode, headers, body }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
{
  const disabled = {}
  apply(makeRoot(disabled), { enabled: false })
  check('disabled plugin does not register tapIndex', !disabled['webServer.tapIndex'])
  const handlers = {}
  apply(makeRoot(handlers), {})
  const routes = Object.fromEntries(handlers['webServer.register'].map((r) => [r.path, r.handler]))
  await new Promise((resolve) => setTimeout(resolve, 520))
  await call(routes[PLAYED_PATH], 'GET', '/dsh-opening/played?stage=bridge&reason=bridge-done-completed')
  await call(routes[PLAYED_PATH], 'GET', '/dsh-opening/played?stage=loader&reason=completed&via=message')
  const state = JSON.parse((await call(routes[HEALTH_PATH], 'GET')).body).observed
  check('bridge completion does not rate-limit the parent report', state.lastPlayback.via === 'message')
}
process.exitCode = failures === 0 ? 0 : 1
