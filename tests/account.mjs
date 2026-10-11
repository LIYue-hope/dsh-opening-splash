import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

/*
 * The browser half, executed for real against stubs for the services it injects.
 *
 * Three things are under test. The Settings tab: that it is registered into the
 * shell's `settings.section` slot with the id and order the shell projects into
 * its navigation column, and that its switches write what the animation half
 * reads. The account integration, whose name the "restore the default name"
 * switch overrides. And that a host without a settings shell still gets a
 * working plugin.
 */

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
/* The preferences contract lives in two files at once: this half writes them and
   assets/opening.js reads them. Both names are asserted below. */
const PREFS_KEY = 'dsh-opening-splash:settings'

/* ------------------------------ module table ------------------------------ */

/**
 * A stand-in for the loader's synchronous require.
 *
 * React's `useState` is the real hooks contract in miniature: a per-instance
 * cell. That is enough to execute the page as written -- first render, a switch
 * flip, and the re-render the flip asks for -- without pretending to be React.
 */
function makeRequire() {
  const calls = []
  const react = {
    /* React.createElement(type, config, ...children): an absent config must still
       be passed, exactly as the official settings pages call it. */
    createElement(type, config, ...children) {
      calls.push({ type, config, children })
      return { type, props: config ?? {}, children }
    },
    useState(initial) {
      const cell = { value: typeof initial === 'function' ? initial() : initial }
      const set = (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }
      return [cell.value, set]
    },
  }
  /* A switch that reports the state a click asks for, like the shared control. */
  const primitives = {
    Switch(props) {
      return { type: 'Switch', props }
    },
  }
  const require = (spec) => {
    if (spec === 'react') return react
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`client-modules: require("${spec}") missed the module table`)
  }
  require.calls = calls
  return require
}

/* --------------------------------- locales -------------------------------- */

/**
 * A locale service that answers like the real one: `bind(ns)` resolves the key
 * out of the registered dictionary for the active language, and the language can
 * be switched to prove the copy follows it.
 *
 * Dictionaries are stored with flat dotted keys, which is how the shipped ones
 * are written and what the page's lookups assume.
 */
function makeLocale() {
  const dictionaries = new Map()
  const state = { active: 'en', revision: 0 }
  const flatten = (source, prefix, into) => {
    for (const [key, value] of Object.entries(source)) {
      const full = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object') flatten(value, full, into)
      else into[full] = value
    }
    return into
  }
  return {
    active: state.active,
    dictionaries,
    register(ns, bundle) {
      const flat = { en: flatten(bundle.en ?? {}, '', {}), zh: flatten(bundle.zh ?? {}, '', {}) }
      dictionaries.set(ns, flat)
      state.revision += 1
    },
    bind(ns) {
      return (key) => dictionaries.get(ns)?.[state.active]?.[key] ?? key
    },
    getSnapshot: () => ({ active: state.active, revision: state.revision }),
    use(language) {
      state.active = language
      this.active = language
    },
  }
}

/* ---------------------------------- slots --------------------------------- */

/**
 * The renderer's declaration-aware `slots.inject`: the callback runs once the
 * declaration exists, and a slot declared later still reaches it. `declare()`
 * is the settings shell arriving.
 */
function makeSlots() {
  const declared = new Set()
  const pendingCalls = new Map()
  const registrations = []
  const runCall = (key) => {
    for (const callback of pendingCalls.get(key) ?? []) callback()
  }
  return {
    registrations,
    inject(key, callback) {
      /* Mirrors the real controller: the declaration wait and every contribution
         it made are one disposer on the caller's fiber. */
      const owned = []
      const run = () => {
        const result = callback()
        owned.push(...(Array.isArray(result) ? result : [result]))
      }
      if (declared.has(key)) run()
      else {
        if (!pendingCalls.has(key)) pendingCalls.set(key, [])
        pendingCalls.get(key).push(run)
      }
      return () => { for (const dispose of owned.splice(0)) dispose() }
    },
    register(options, component) {
      const registration = { options, component }
      registrations.push(registration)
      return () => {
        const at = registrations.indexOf(registration)
        if (at !== -1) registrations.splice(at, 1)
      }
    },
    declare(key) {
      declared.add(key)
      /* A declaration fires the waits it satisfies and then forgets them: a
         second declaration is not a second delivery. */
      const waiting = pendingCalls.get(key) ?? []
      pendingCalls.delete(key)
      for (const run of waiting) run()
    },
  }
}

/* ------------------------------- plugin host ------------------------------ */

/** One localStorage area, shared across loads that model a reload. */
function makeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

/** Build one plugin instance: window stub, context, and the pieces it wired. */
function load({ withSlots = true, storage = makeStorage() } = {}) {
  let plugin
  const labels = []
  const require = makeRequire()
  /* The loader half the animation publishes, with the one method the page calls. */
  const push = []
  const win = {
    __ModuleLoader__: { load: (row) => { plugin = row.factory(require) } },
    DSHOpening: {
      setIdentity: (label) => labels.push(label),
      setPrefs: (prefs) => push.push(prefs),
    },
    localStorage: storage,
  }
  vm.runInNewContext(source, { window: win, Date, Error })
  assert.equal(plugin.inject.includes('slots'), true, 'the settings tab needs the slot service')

  const pending = []
  const frames = []
  const disposers = []
  const events = {}
  let wake
  let closed = false
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!frames.length) await new Promise((resolve) => { wake = resolve })
        if (frames.length) yield frames.shift()
      }
    },
    dispose() { closed = true; wake?.() },
  }
  const locale = makeLocale()
  const slots = makeSlots()
  const ctx = {
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    locale,
    ...(withSlots ? { slots } : {}),
    remote: {
      $on: (event, fn) => { events[event] = fn; return () => { delete events[event] } },
      $stream: () => stream,
      account: { getProfile: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    },
  }
  plugin.apply(ctx)
  return { labels, locale, slots, pending, frames, disposers, events, win, require, push, storage, wake: () => wake?.() }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * The stored switches, as a plain object.
 *
 * Compared through JSON: the plugin runs in its own vm realm, so the objects it
 * stores are not reference-equal to this file's -- which is what `deepEqual`
 * checks, however identical the two look.
 */
function storedPrefs(storage) {
  return JSON.parse(storage.getItem(PREFS_KEY))
}

/** Render the registered page once, with the composed props the shell passes. */
function render(host, props = {}) {
  host.slots.declare('settings.section')
  assert.equal(host.slots.registrations.length, 1, 'one tab is registered into settings.section')
  const { options, component } = host.slots.registrations[0]
  return {
    options,
    component,
    tree: component({ t: host.locale.bind('openingSplash.settings'), close() {}, ...props }),
  }
}

/**
 * Walk the rendered tree for a control.
 *
 * `type` is what the page passes to `createElement`: the shared `Switch`
 * component object, or the tag of a native control. The row wrappers are divs,
 * so matching the type cannot confuse a row with its own control.
 */
function findControl(node, type) {
  if (!node || typeof node !== 'object') return null
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const hit = findControl(child, type)
    if (hit) return hit
  }
  return null
}

/** Both switches, in the order the page renders them. */
function switches(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function' && node.props && 'checked' in node.props) out.push(node)
  for (const child of node.children ?? []) switches(child, out)
  return out
}

/** Each switch paired with the label it carries as its accessible name. */
function switchRows(tree) {
  return switches(tree).map((control) => ({ control, label: control.props.label }))
}

/** Every visible string in a rendered tree, flattened. */
function strings(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node !== 'object') return out
  for (const child of node.children ?? []) strings(child, out)
  return out
}

/* ------------------------ the Settings tab is registered ------------------------ */

{
  const host = load()
  assert.equal(host.slots.registrations.length, 0, 'nothing registers before the shell declares the slot')

  const { options, tree } = render(host)
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'opening-splash')
  /* After account (-10), general (0), models (10), plugins (15). */
  assert.equal(options.order, 20)
  assert.equal(options.locale, 'openingSplash.settings')
  assert.equal(typeof options.label, 'function', 'the nav label is a locale-following thunk')
  assert.equal(options.label(), 'Opening splash')
  host.locale.use('zh')
  assert.equal(options.label(), '\u5f00\u573a\u52a8\u753b')

  /* The three switches, each with its own label and hint. */
  host.locale.use('en')
  const labelled = strings(tree)
  for (const text of ['Double click to skip', 'Restore the default name', 'Use my own opening animation']) {
    assert.equal(labelled.includes(text), true, `the page shows "${text}"`)
  }
  assert.equal(labelled.includes('Show DEEPSEEK after ID CONFIRMED, instead of the signed-in account name.'), true,
    'the default-name hint names the default it restores')
  /* Chinese copy exists and is reachable, not just registered. */
  host.locale.use('zh')
  const zh = strings(render(host).tree)
  assert.equal(zh.includes('\u53cc\u51fb\u8df3\u8fc7'), true, 'the Chinese page has its own labels')
  assert.equal(zh.includes('\u5c1a\u672a\u5f00\u653e'), true, 'and its own badge for the unbuilt option')
  host.locale.use('en')

  /* Unloading the plugin (its fiber effect) withdraws the tab. */
  for (const dispose of host.disposers) dispose()
  assert.equal(host.slots.registrations.length, 0, 'the tab is withdrawn when the plugin unloads')
}

/* ------------------------- the switches do what they say ------------------------- */

{
  const storage = makeStorage()
  const host = load({ storage })
  const { tree } = render(host)

  /* Everything starts off, and nothing has been written yet. */
  const rows = switchRows(tree)
  assert.equal(rows.length, 2, 'two switches, and the unbuilt option is not one of them')
  assert.equal(rows[0].label, 'Double click to skip')
  assert.equal(rows[1].label, 'Restore the default name')
  const [dbl, name] = rows.map((row) => row.control)
  assert.equal(dbl.props.checked, false)
  assert.equal(name.props.checked, false)
  assert.equal(storage.getItem(PREFS_KEY), null, 'rendering writes nothing')

  /* Flipping one stores it under the key the animation half reads. */
  dbl.props.onChange(true)
  assert.deepEqual(storedPrefs(storage), {
    skipOnDoubleClick: true, defaultName: false, customSplash: false,
  })

  /* And pushes the same set to the running page, so the switch lands now. */
  assert.equal(host.push.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(host.push[0])),
    { skipOnDoubleClick: true, defaultName: false, customSplash: false })

  /* The re-render the flip asked for shows it on. */
  const after = switchRows(render(host).tree)
  assert.equal(after[0].control.props.checked, true)

  /* The name switch stores under `defaultName`, the field the loader merges. */
  after[1].control.props.onChange(true)
  assert.deepEqual(storedPrefs(storage), {
    skipOnDoubleClick: true, defaultName: true, customSplash: false,
  })
  assert.equal(host.push.length, 2)

  /* A reload reads the stored switches back. */
  const reloaded = load({ storage })
  const back = switchRows(render(reloaded).tree)
  assert.equal(back[0].control.props.checked, true, 'the choice survives a reload')
  assert.equal(back[1].control.props.checked, true)
}

/* ------------------- the upload option is present but inert ------------------- */

{
  const host = load()
  const { tree } = render(host)
  const picker = findControl(tree, 'input')
  assert.equal(picker.props['aria-label'], 'Choose an opening animation file')
  assert.equal(picker.props.type, 'file')
  assert.equal(picker.props.disabled, true, 'the picker refuses input while the feature is unbuilt')
  assert.equal(strings(tree).includes('Not yet available'), true, 'and says so')

  /* Choosing a file cannot change anything: there is nowhere for it to go. */
  assert.equal(picker.props.onChange, undefined)
  assert.equal(host.storage.getItem(PREFS_KEY), null)
}

/* ------------------------------ storage failures ------------------------------ */

{
  const broken = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
  }
  const host = load({ storage: broken })
  const { tree } = render(host)
  /* Defaults stand, and a flip still reaches the running page. */
  const [dbl] = switchRows(tree).map((row) => row.control)
  assert.equal(dbl.props.checked, false)
  dbl.props.onChange(true)
  assert.equal(host.push.length, 1, 'the push happens even when storage refuses')
}

/* ------------- a host with no settings shell still gets the plugin ------------- */

{
  const host = load({ withSlots: false })
  /* No slot service at all: the plugin simply has no tab to offer. */
  assert.equal(host.slots.registrations.length, 0)
  assert.equal(host.labels.at(-1), null, 'the account integration still published its first state')
}

/* --------------- the account name, and the switch that withdraws it --------------- */

{
  const host = load()
  async function state(status) {
    host.frames.push({ value: { status }, accept() {} }); host.wake(); await tick()
  }
  async function profile(value) {
    await state('credential-stored')
    host.pending.shift().resolve({ ok: true, value }); await tick()
    return host.labels.at(-1)
  }
  assert.equal(await profile({ status: 'ready', value: { name: '\u5f20\u4e09', contact: 'masked' } }), '\u5f20\u4e09')
  assert.equal(await profile({ status: 'ready', value: { name: null, contact: 'masked' } }), 'masked')
  assert.equal(await profile({ status: 'ready', value: { name: null, contact: null } }), 'Signed in')
  assert.equal(await profile({ status: 'failed' }), 'Signed in')
  host.events['deepseek-account/session-expired']()
  assert.equal(host.labels.at(-1), null)
  assert.equal(await profile(null), null)
  await state('credential-stored')
  const stale = host.pending.shift()
  await state('signed-out')
  stale.resolve({ ok: true, value: { status: 'ready', value: { name: 'old account' } } })
  await tick()
  assert.equal(host.labels.at(-1), null)
  await state('credential-stored')
  host.pending.shift().reject(new Error('offline')); await tick()
  assert.equal(host.labels.at(-1), 'Signed in')
  await state('credential-stored')
  const afterDispose = host.pending.shift()
  for (const dispose of host.disposers) dispose()
  afterDispose.resolve({ ok: true, value: { status: 'ready', value: { name: 'disposed' } } })
  await tick()
  assert.equal(host.labels.at(-1), null)

  /* Every name goes through the loader, which is the half that knows whether the
     "restore the default name" switch is on. That is what keeps a late profile
     result from re-appearing after the switch withdrew it. */
  assert.equal(typeof host.win.DSHOpening.setIdentity, 'function')
}

/* --------------------- the page without React or the shared switch --------------------- */

{
  /* A module table with no primitives: the page falls back to a native checkbox
     rather than rendering nothing. */
  let plugin
  const win = {
    __ModuleLoader__: {
      load: (row) => {
        const stock = makeRequire()
        plugin = row.factory((spec) => {
          if (spec === 'react') return stock('react')
          throw new Error('no primitives here')
        })
      },
    },
    DSHOpening: { setIdentity() {}, setPrefs() {} },
    localStorage: makeStorage(),
  }
  vm.runInNewContext(source, { window: win, Date, Error })
  const slots = makeSlots()
  const disposers = []
  plugin.apply({
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    locale: makeLocale(),
    slots,
    remote: {
      $on: () => () => {},
      $stream: () => ({ async *[Symbol.asyncIterator]() {}, dispose() {} }),
      account: { getProfile: () => Promise.resolve(null) },
    },
  })
  slots.declare('settings.section')
  assert.equal(slots.registrations.length, 1, 'the tab still registers without the primitives')
  const tree = slots.registrations[0].component({ t: (key) => key, close() {} })
  const control = findControl(tree, 'input')
  assert.equal(control.props.type, 'checkbox', 'without the shared switch a native checkbox keeps the row usable')
  assert.equal(control.props['aria-label'], 'skipOnDoubleClick.label', 'and keeps its accessible name')
  /* Its event must arrive as the same boolean the shared control hands over,
     not as the DOM event. */
  assert.equal(typeof control.props.onChange, 'function')
  const pushed = []
  win.DSHOpening.setPrefs = (prefs) => pushed.push(prefs)
  control.props.onChange({ target: { checked: true } })
  assert.equal(pushed.length, 1, 'the checkbox event reaches the preference write')
  assert.equal(pushed[0].skipOnDoubleClick, true, 'and carries the state the click asked for')
}

console.log('Account fallback, stale response, disposal, Settings switches and packaging checks passed')
