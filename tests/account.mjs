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
 * React's `useState` is the real hooks contract in miniature: a per-component
 * cell that survives re-renders, read in call order. That is enough to execute
 * the page as written -- first render, a switch flip, the re-render it asks for,
 * and the state an asynchronous step writes afterwards -- without pretending to
 * be React. The cells hang off the component identity, so re-invoking the
 * component is exactly a re-render.
 */
function makeRequire() {
  const calls = []
  const cellsByComponent = new WeakMap()
  let current = null
  let cursor = 0
  const react = {
    /* React.createElement(type, config, ...children): an absent config must still
       be passed, exactly as the official settings pages call it. */
    createElement(type, config, ...children) {
      calls.push({ type, config, children })
      return { type, props: config ?? {}, children }
    },
    useState(initial) {
      const owner = current
      if (!owner) throw new Error('useState called outside a component render')
      const store = cellsByComponent.get(owner) ?? []
      const at = cursor
      cursor += 1
      if (!(at in store)) store[at] = typeof initial === 'function' ? initial() : initial
      cellsByComponent.set(owner, store)
      const set = (next) => { store[at] = typeof next === 'function' ? next(store[at]) : next }
      return [store[at], set]
    },
  }
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
  require.primitives = primitives
  /** Mark `component` as the render in progress, so hooks land on it. */
  require.begin = (component) => { current = component; cursor = 0 }
  return require
}

/** Render a component the way the slot renderer does: as a function call. */
function renderComponent(host, component, props) {
  host.require.begin(component)
  return component(props)
}

/* --------------------------------- locales -------------------------------- */

/**
 * A locale service that answers like the real one.
 *
 * The real `translate` reads `dict[key]` verbatim -- it does NOT descend into
 * nested objects -- so the stub must not either: a nested dictionary would then
 * answer `undefined` for every dotted key and the lookup would fall silently
 * through to English. Flattening here would hide exactly that bug.
 */
function makeLocale() {
  const dictionaries = new Map()
  const state = { active: 'en', revision: 0 }
  return {
    active: state.active,
    dictionaries,
    register(ns, bundle) {
      dictionaries.set(ns, { en: { ...(bundle.en ?? {}) }, zh: { ...(bundle.zh ?? {}) } })
      state.revision += 1
    },
    /* Mirrors `translate`: namespace, then `common`, then the key itself. */
    bind(ns) {
      return (key, params) => {
        const found = dictionaries.get(ns)?.[state.active]?.[key]
        const template = typeof found === 'string' ? found : key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
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

/**
 * An in-memory IndexedDB, small enough to be honest about the contract the page
 * uses: `open` (with its upgrade callback), `transaction(store, mode)`,
 * `objectStore().put/get/delete`, and the request/transaction events.
 *
 * It is deliberately asynchronous, because the page's read path is: a
 * synchronous stub would let a broken promise chain pass.
 */
function makeIndexedDB() {
  const records = new Map()
  const makeRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null })
  const store = {
    put(value, key) {
      const request = makeRequest()
      records.set(key, value)
      request.result = key
      queueMicrotask(() => request.onsuccess && request.onsuccess())
      return request
    },
    get(key) {
      const request = makeRequest()
      request.result = records.has(key) ? records.get(key) : undefined
      queueMicrotask(() => request.onsuccess && request.onsuccess())
      return request
    },
    delete(key) {
      const request = makeRequest()
      records.delete(key)
      queueMicrotask(() => request.onsuccess && request.onsuccess())
      return request
    },
  }
  const database = {
    objectStoreNames: { contains: (name) => name === 'splash' },
    createObjectStore() {},
    transaction() {
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null, objectStore: () => store }
      queueMicrotask(() => queueMicrotask(() => tx.oncomplete && tx.oncomplete()))
      return tx
    },
  }
  return {
    records,
    open() {
      const request = { result: database, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null }
      queueMicrotask(() => {
        if (request.onupgradeneeded) request.onupgradeneeded()
        if (request.onsuccess) request.onsuccess()
      })
      return request
    },
  }
}

/** Build one plugin instance: window stub, context, and the pieces it wired. */
function load({ withSlots = true, storage = makeStorage(), indexedDB = makeIndexedDB(), noIndexedDB = false } = {}) {
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
  /* `noIndexedDB` leaves the property off entirely, which is what a browser
     without one answers. */
  if (!noIndexedDB) win.indexedDB = indexedDB
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
  /* Every load starts in English: the language is one service shared by all the
     blocks, and a block that switches it would otherwise decide for the next. */
  locale.use('en')
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
  return { labels, locale, slots, pending, frames, disposers, events, win, require, push, storage, indexedDB, wake: () => wake?.() }
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
    tree: renderComponent(host, component, { t: host.locale.bind('openingSplash.settings'), close() {}, ...props }),
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

/** The button whose visible text is `label`, if the tree has one. */
function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' && (node.children ?? []).includes(label)) return node
  for (const child of node.children ?? []) {
    const hit = findButton(child, label)
    if (hit) return hit
  }
  return null
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

  /* The three rows, each with its own label and hint. */
  host.locale.use('en')
  const labelled = strings(tree)
  for (const text of ['Double click to skip', 'Restore the default name', 'Use my own opening animation']) {
    assert.equal(labelled.includes(text), true, `the page shows "${text}"`)
  }
  assert.equal(labelled.includes('Show DEEPSEEK after ID CONFIRMED, instead of the signed-in account name.'), true,
    'the default-name hint names the default it restores')
  /* The keys really resolve: an unresolved one would render as the key itself.
     This is what a nested dictionary silently produced -- English in every
     language, because the lookup fell through the whole chain to the key. */
  assert.equal(labelled.some((text) => text.includes('.label') || text.includes('.hint')), false,
    'no label or hint renders as its own locale key')

  /* Chinese copy resolves through the same path, not just registered. */
  host.locale.use('zh')
  const zh = strings(render(host).tree)
  assert.equal(zh.includes('\u53cc\u51fb\u8df3\u8fc7'), true, 'the Chinese page has its own labels')
  assert.equal(zh.includes('\u6062\u590d\u9ed8\u8ba4\u540d\u5b57'), true, 'and its own default-name label')
  assert.equal(zh.includes('\u4f7f\u7528\u81ea\u5b9a\u4e49\u5f00\u5c4f\u52a8\u753b'), true, 'and its own upload label')
  assert.equal(zh.includes('\u5c1a\u672a\u5f00\u653e'), false, 'the "not yet available" badge is gone with the feature landing')
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
  assert.equal(rows.length, 3, 'one switch per setting, upload included')
  assert.equal(rows[0].label, 'Double click to skip')
  assert.equal(rows[1].label, 'Restore the default name')
  assert.equal(rows[2].label, 'Play my own opening animation')
  const [dbl, name, uploadSwitch] = rows.map((row) => row.control)
  assert.equal(dbl.props.checked, false)
  assert.equal(name.props.checked, false)
  assert.equal(uploadSwitch.props.checked, false)
  /* With no file kept, the upload switch cannot be turned on: it would silently
     play the built-in opening instead of what the user thinks they chose. */
  assert.equal(uploadSwitch.props.disabled, true, 'no file means nothing to turn on')
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

/* ---------------------- uploading an opening animation ---------------------- */

/** A stand-in for the File the picker hands over. */
function fakeFile(name, size, type) {
  return { name, size, type, slice: () => null }
}

const tick2 = () => new Promise((resolve) => setImmediate(resolve))
/** The picker is the file input, not one of the switches. */
const pickerOf = (tree) => findControl(tree, 'input')

{
  const storage = makeStorage()
  const db = makeIndexedDB()
  const host = load({ storage, indexedDB: db })
  const tree = render(host).tree

  const picker = pickerOf(tree)
  assert.equal(picker.props.type, 'file', 'the row offers a real file picker')
  assert.equal(picker.props.accept, 'video/*', 'and asks for video files')
  assert.equal(picker.props.disabled, false, 'the picker is live now that the feature exists')
  assert.equal(strings(tree).includes('Not yet available'), false, 'and no longer says it is unavailable')

  /* Choosing a file keeps the file and turns the switch on -- one gesture, not
     two, because a saved file nobody will play is not what was asked for. */
  const file = fakeFile('my-intro.mp4', 4096, 'video/mp4')
  picker.props.onChange({ target: { files: [file] } })
  await tick2()
  assert.equal(db.records.get('custom'), file, 'the file itself goes to the database')
  assert.deepEqual(JSON.parse(storage.getItem('dsh-opening-splash:upload')),
    { name: 'my-intro.mp4', size: 4096, type: 'video/mp4' }, 'and its description to the string store')
  assert.deepEqual(storedPrefs(storage), {
    skipOnDoubleClick: false, defaultName: false, customSplash: true,
  }, 'saving a file turns the switch on')
  assert.equal(host.push.at(-1).customSplash, true, 'and the running page is told')

  /* The row now describes what is kept, and offers to remove it. */
  const afterUpload = render(host).tree
  const described = strings(afterUpload)
  assert.equal(described.some((text) => text.includes('my-intro.mp4')), true, 'the row names the kept file')
  assert.equal(described.some((text) => text.includes('4.0 KB')), true, 'and its size')
  assert.equal(described.includes('Remove'), true, 'and offers to remove it')
  assert.equal(switchRows(afterUpload)[2].control.props.disabled, false, 'the upload switch can now be turned on')

  /* The switch can be turned back off without losing the file. */
  switchRows(afterUpload)[2].control.props.onChange(false)
  assert.equal(storedPrefs(storage).customSplash, false, 'the animation can be parked without deleting it')
  assert.equal(db.records.has('custom'), true, 'the file is still kept')

  /* Removing forgets both halves and parks the switch. */
  const removeButton = findButton(afterUpload, 'Remove')
  assert.ok(removeButton, 'the remove button is there')
  removeButton.props.onClick()
  await tick2()
  assert.equal(db.records.has('custom'), false, 'the file is gone from the database')
  assert.equal(storage.getItem('dsh-opening-splash:upload'), null, 'and from the description store')
  assert.equal(storedPrefs(storage).customSplash, false, 'and the switch is off')
}

{
  /* Refusals are reported, and none of them leaves a half-state behind. */
  const storage = makeStorage()
  const db = makeIndexedDB()
  const host = load({ storage, indexedDB: db })
  let tree = render(host).tree

  /* No file chosen at all. */
  pickerOf(tree).props.onChange({ target: { files: [] } })
  await tick2()
  assert.equal(strings(render(host).tree).includes('Choose a video file first.'), true, 'an empty choice says so')
  assert.equal(db.records.size, 0, 'and stores nothing')

  /* A file past the ceiling. */
  tree = render(host).tree
  pickerOf(tree).props.onChange({ target: { files: [fakeFile('huge.mp4', 300 * 1024 * 1024, 'video/mp4')] } })
  await tick2()
  const large = strings(render(host).tree)
  assert.equal(large.some((text) => text.includes('larger than') && text.includes('200.0 MB')), true,
    'an oversized file is refused with the ceiling named')
  assert.equal(db.records.size, 0, 'and nothing is stored')

  /* An empty file. */
  tree = render(host).tree
  pickerOf(tree).props.onChange({ target: { files: [fakeFile('empty.mp4', 0, 'video/mp4')] } })
  await tick2()
  assert.equal(strings(render(host).tree).includes('That file is empty.'), true, 'an empty file says so')
  assert.equal(storedPrefs(storage)?.customSplash, undefined, 'and the switch is never turned on')

  /* A database that refuses the write. */
  const broken = makeIndexedDB()
  broken.open = () => {
    const request = { result: null, error: new Error('denied') }
    queueMicrotask(() => request.onerror && request.onerror())
    return request
  }
  const failing = load({ storage: makeStorage(), indexedDB: broken })
  pickerOf(render(failing).tree).props.onChange({ target: { files: [fakeFile('a.mp4', 1000, 'video/mp4')] } })
  await tick2()
  const failed = strings(render(failing).tree)
  assert.equal(failed.some((text) => text.includes('refused to store')), true, 'a refused write is reported')
}

{
  /* A browser without IndexedDB cannot keep a file, and says so rather than
   * offering a picker that would silently drop it. */
  const host = load({ noIndexedDB: true })
  const tree = render(host).tree
  const said = strings(tree)
  assert.equal(said.some((text) => text.includes('IndexedDB')), true, 'the page explains why uploads are off')
  assert.equal(pickerOf(tree).props.disabled, true, 'and the picker refuses input')
  assert.equal(switchRows(tree)[2].control.props.disabled, true, 'and so does its switch')
}

{
  /* The upload's own description is validated on read: junk in the slot must not
     make the row claim a file is kept. */
  const storage = makeStorage()
  storage.setItem('dsh-opening-splash:upload', '{"nonsense":true}')
  const host = load({ storage })
  assert.equal(strings(render(host).tree).some((text) => text.includes('Kept:')), false,
    'a malformed description is not believed')

  const broken2 = makeStorage()
  broken2.setItem('dsh-opening-splash:upload', 'not json at all')
  const host2 = load({ storage: broken2 })
  assert.equal(strings(render(host2).tree).some((text) => text.includes('Kept:')), false,
    'and unreadable JSON is not believed either')
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
  let stock
  const win = {
    __ModuleLoader__: {
      load: (row) => {
        stock = makeRequire()
        plugin = row.factory((spec) => {
          if (spec === 'react') return stock('react')
          throw new Error('no primitives here')
        })
      },
    },
    DSHOpening: { setIdentity() {}, setPrefs() {} },
    localStorage: makeStorage(),
    indexedDB: makeIndexedDB(),
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
  const tree = renderComponent({ require: stock }, slots.registrations[0].component, { t: (key) => key, close() {} })
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
