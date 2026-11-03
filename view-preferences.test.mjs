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
  assert.equal(state.compactLanes, true)
  state.set({ hours: 6, compactLanes: false })
  await state.flush()
  const restored = await loadViewPreferences(storage)
  assert.equal(restored.hours, 6)
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
