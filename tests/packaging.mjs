import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

/*
 * The packaging contract around the Settings tab.
 *
 * The tab is delivered by the client module system, and every step between this
 * repository and the rendered navigation column is a declaration that can be
 * wrong while every other check still passes:
 *
 *   package.json exports["./client"]  ->  the bundle the module system serves
 *   package.json dsh.client.inject    ->  the package that declares the slot
 *   the row registered on __ModuleLoader__  ->  the factory the loader materializes
 *
 * A mistake in any of them shows up as "the tab is simply not there", with no
 * error anywhere. These checks fail at build time instead.
 */

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))

/* ------------------------------- the manifest ------------------------------ */

assert.equal(pkg.exports['./client'], './lib/client.js',
  'the module system resolves the client bundle through exports["./client"]')
assert.equal(pkg.exports['.'], './lib/index.js')
assert.deepEqual(pkg.dsh.client.platform, 'web',
  'the settings shell is a web-client surface')
assert.equal(
  pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'),
  true,
  'settings.section is declared by ui-settings-general: without it the graph does not order that row before this one',
)
assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'), true,
  'the settings page renders the shared Switch through the primitives row')
assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'), true,
  'the nav label and the page copy resolve through the locale service')

/* Everything the runtime reads must survive `npm pack`, which follows `files`. */
for (const needed of ['lib', 'assets']) {
  assert.equal(pkg.files.includes(needed), true, `files must ship ${needed}/`)
}

/* ------------------------- the loader registration ------------------------- */

let row
const win = { __ModuleLoader__: { load: (registration) => { row = registration } } }
vm.runInNewContext(fs.readFileSync(new URL('lib/client.js', root), 'utf8'), { window: win, Date, Error })
assert.ok(row, 'the client bundle must register itself on __ModuleLoader__')
assert.equal(row.id, 'dsh-opening-splash', 'the row id is the graph row / package name')
assert.equal(typeof row.factory, 'function', 'the loader calls factory(require)')

/* `factory(require)` -- the module table reader -- is how React and the shared
   primitives arrive, and the factory must hand back the plugin object form so
   `inject` can gate services. Both reads are guarded: a table without them still
   yields a working plugin and an operable page. */
const seen = []
const plugin = row.factory((spec) => {
  seen.push(spec)
  throw new Error('not in this table')
})
assert.deepEqual(seen, ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  'React and the shared Switch are each resolved once, at materialization')
assert.equal(typeof plugin.apply, 'function')
assert.equal(Array.isArray(plugin.inject), true)
assert.equal(plugin.inject.includes('slots'), true,
  'the slot service gates the plugin; the runtime parks it when absent')

/* And with them present, the settings page really does use the shared switch. */
{
  let registered = null
  const react = { createElement: (type, config, ...children) => ({ type, props: config ?? {}, children }), useState: (v) => [typeof v === 'function' ? v() : v, () => {}] }
  const primitives = { Switch: (props) => ({ type: 'Switch', props }) }
  const withDeps = row.factory((spec) => {
    if (spec === 'react') return react
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require("${spec}")`)
  })
  withDeps.apply({
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') dispose() },
    locale: { register() {}, bind: () => (key) => key, getSnapshot: () => ({ active: 'en' }) },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) { registered = { options, component }; return () => {} },
    },
    remote: {
      $on: () => () => {},
      $stream: () => ({ async *[Symbol.asyncIterator]() {}, dispose() {} }),
      account: { getProfile: () => Promise.resolve(null) },
    },
  })
  assert.ok(registered, 'the settings tab registers once the shell declares the slot')
  const tree = registered.component({ t: (key) => key, close() {} })
  const controls = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === primitives.Switch) controls.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  assert.equal(controls.length, 2, 'the page renders the two switches this plugin honours')
}

/* The whole apply must survive a table with no React: the splash, the routes and
   the account name are the plugin\'s job, the settings page is the extra. */
const disposers = []
plugin.apply({
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  locale: { register() {}, bind: () => () => 'x', getSnapshot: () => ({ active: 'en' }) },
  slots: { inject: () => () => {}, register: () => () => {} },
  remote: {
    $on: () => () => {},
    $stream: () => ({ async *[Symbol.asyncIterator]() {}, dispose() {} }),
    account: { getProfile: () => Promise.resolve(null) },
  },
})
assert.ok(disposers.length > 0, 'apply wired its effects')
for (const dispose of disposers) dispose()

console.log('Client packaging contract checks passed')
