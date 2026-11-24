import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadViewPreferences } from './view-preferences.mjs'

test('preferences restore valid fields, reject invalid values and preserve unrelated cache data', async () => {
  const data = new Map([
    ['view:window-hours', -1],
    ['view:compact-lanes', true],
    ['activity-v1:head', { version: 1 }]
  ])
  const storage = {
    get: async (key) => data.get(key),
    set: async (key, value) => data.set(key, value)
  }
  const state = await loadViewPreferences(storage)
  assert.equal(state.hours, 24)
  assert.equal(state.hideShortTasks, true)
  assert.equal(state.compactLanes, true)
  state.set({ hours: 6, compactLanes: false, hideShortTasks: false })
  await state.flush()
  const restored = await loadViewPreferences(storage)
  assert.equal(restored.hours, 6)
  assert.equal(restored.hideShortTasks, false)
  assert.equal(restored.compactLanes, false)
  assert.deepEqual(data.get('activity-v1:head'), { version: 1 })
})

test('coalesced zoom changes and queued writes keep the final preference even with slow storage', async () => {
  const writes = []
  let complete
  const first = new Promise((resolve) => {
    complete = resolve
  })
  const state = await loadViewPreferences({
    get: async () => null,
    set: async (key, value) => {
      await first
      writes.push([key, value])
    }
  })
  state.set({ hours: 6 })
  state.set({ hours: 12 }, true)
  state.set({ hours: 48 }, true)
  const flushed = state.flush()
  complete()
  await flushed
  assert.deepEqual(writes, [
    ['view:window-hours', 6],
    ['view:window-hours', 48]
  ])
})

test('a new worker restores large legacy pin lists and verifies storage before acknowledging a change', async () => {
  const { createSharedPreferences } = await import('./shared-preferences.mjs')
  const key = (n) =>
    JSON.stringify([
      'local',
      'sample-repository::/Users/demo/Projects/Sample/feature-branch',
      'codex',
      'session',
      '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
    ])
  const pins = []
  for (let n = 0; Buffer.byteLength(JSON.stringify(pins)) <= 64 * 1024; n++) pins.push(key(n))
  const data = new Map([
    ['view:pinned-terminals', pins],
    ['view:language', 'ja']
  ])
  let dropWrites = false
  const storage = {
    get: async (k) => data.get(k),
    keys: async () => [...data.keys()],
    set: async (k, v) => {
      if (!dropWrites) data.set(k, v)
    }
  }
  let posts = 0
  const open = () => createSharedPreferences(storage, () => posts++)
  const worker = open()
  const id = key(pins.length)
  const toggle = { field: 'pinnedTerminals', key: id }
  dropWrites = true
  await assert.rejects(worker.change(toggle), /confirmed/)
  assert.equal(posts, 0)
  assert.equal((await worker.read()).pinnedTerminals.has(id), false)
  dropWrites = false
  await worker.change(toggle)
  const restored = await open().read()
  assert.equal(restored.language, 'ja')
  assert.deepEqual([...restored.pinnedTerminals], [...pins, id])
  const full = [
    key(1),
    '字'.repeat(Math.floor((256 * 1024 - Buffer.byteLength(JSON.stringify([key(1), '']))) / 3))
  ]
  data.set('view:pinned-terminals', full)
  const nearLimit = open()
  assert.deepEqual(await nearLimit.change(toggle), { saved: false, reason: 'pinLimit' })
  assert.deepEqual(data.get('view:pinned-terminals'), full)
  await nearLimit.change({ field: 'pinnedTerminals', key: full[0] })
  await nearLimit.change({ field: 'pinnedTerminals', key: 'compact' })
  assert.deepEqual([...(await open().read()).pinnedTerminals], [full[1], 'compact'])
})
