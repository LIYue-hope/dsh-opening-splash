import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let plugin
const labels = []
const win = {
  __ModuleLoader__: { load: (row) => { plugin = row.factory() } },
  DSHOpening: { setIdentity: (label) => labels.push(label) },
}
vm.runInNewContext(source, { window: win, Date, Error })
const pending = []
const frames = []
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
const disposers = []
const events = {}
const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  locale: {
    register() {}, bind: () => () => 'Signed in', getSnapshot: () => ({ active: 'en' }),
  },
  remote: {
    $on: (event, fn) => { events[event] = fn; return () => { delete events[event] } },
    $stream: () => stream,
    account: { getProfile: (client) => {
      assert.equal(client.version, '0.2.0-rc.2')
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    } },
  },
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function state(status) {
  frames.push({ value: { status }, accept() {} }); wake?.(); await tick()
}
async function profile(value) {
  await state('credential-stored')
  pending.shift().resolve({ ok: true, value }); await tick()
  return labels.at(-1)
}
plugin.apply(ctx)
assert.equal(await profile({ status: 'ready', value: { name: '\u5f20\u4e09', contact: 'masked' } }), '\u5f20\u4e09')
assert.equal(await profile({ status: 'ready', value: { name: null, contact: 'masked' } }), 'masked')
assert.equal(await profile({ status: 'ready', value: { name: null, contact: null } }), 'Signed in')
assert.equal(await profile({ status: 'failed' }), 'Signed in')
events['deepseek-account/session-expired']()
assert.equal(labels.at(-1), null)
assert.equal(await profile(null), null)
await state('credential-stored')
const stale = pending.shift()
await state('signed-out')
stale.resolve({ ok: true, value: { status: 'ready', value: { name: 'old account' } } })
await tick()
assert.equal(labels.at(-1), null)
await state('credential-stored')
pending.shift().reject(new Error('offline')); await tick()
assert.equal(labels.at(-1), 'Signed in')
await state('credential-stored')
const afterDispose = pending.shift()
for (const dispose of disposers) dispose()
afterDispose.resolve({ ok: true, value: { status: 'ready', value: { name: 'disposed' } } })
await tick()
assert.equal(labels.at(-1), null)
console.log('Account fallback, stale response and disposal checks passed')
