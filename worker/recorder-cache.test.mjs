import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { ActivityStore } from './activity-store.mjs'
import { encodeRecorderCache, decodeRecorderCache } from './recorder-cache.mjs'

test('large seven-day history survives compressed storage and restore without losing identity', () => {
  const now = Date.now()
  const store = new ActivityStore(now)
  const agent = store.agent('native:codex:session', {
    provider: 'codex',
    providerSessionId: 'session',
    workspace: 'repo::/work',
    resumeTarget: { kind: 'terminal', providerSessionId: 'session', executionHostId: 'local' }
  })
  for (let i = 0; i < 5000; i++) {
    store.point(
      `live:tab:leaf:${i}:${'placement'.repeat(32)}`,
      agent,
      now - 20000 + i,
      i % 2 ? 'done' : 'blocked',
      'live',
      now - 19999 + i
    )
  }
  const saved = store.serialize()
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 1800 * 1024)
  const chunks = encodeRecorderCache(saved)
  assert.ok(chunks.length <= 100)
  assert.ok(chunks.every((c) => c.length <= 24000))
  const restored = new ActivityStore(now)
  restored.restore(decodeRecorderCache({ version: 2 }, chunks), now)
  assert.equal(restored.points.size, 5000)
  assert.deepEqual(restored.agents.get(agent), store.agents.get(agent))
  assert.deepEqual(restored.snapshot(now), store.snapshot(now))
})

test('legacy recorder history is readable and migrates on the next save', () => {
  const saved = { agents: [], points: [], aliases: [], messages: [], collectingSince: 10 }
  const old = JSON.stringify(saved)
  const restored = decodeRecorderCache({ version: 1 }, [old.slice(0, 30), old.slice(30)])
  assert.deepEqual(restored, saved)
  assert.deepEqual(decodeRecorderCache({ version: 2 }, encodeRecorderCache(restored)), saved)
})

test('a 5000-point cache grows to 8196 without losing old transitions or widening the reply budget', () => {
  const now = Date.now()
  const start = now - 6 * 24 * 3600000
  const store = new ActivityStore(start)
  store.agent('session', { provider: 'codex', sessionId: 'session' })
  const append = (target, first, end) => {
    for (let i = first; i < end; i++) {
      const at = start + i * 60000
      target.point('point-' + i, 'session', at, i % 2 ? 'done' : 'working', 'live', at + 30000)
    }
  }
  append(store, 0, 5000)
  const old = store.serialize()
  const restored = new ActivityStore(now)
  restored.restore(decodeRecorderCache({ version: 2 }, encodeRecorderCache(old)), now)
  append(restored, 5000, 8196)
  restored.collectedUntil = now
  const wide = restored.snapshot(now)
  assert.equal(restored.points.size, 8196)
  assert.equal(
    wide.agents.reduce((count, lane) => count + lane.segments.length, 0),
    4000
  )
  const saved = decodeRecorderCache({ version: 2 }, encodeRecorderCache(restored.serialize()))
  assert.deepEqual(saved.points.slice(0, 5000), old.points)
  const reloaded = new ActivityStore(now)
  reloaded.restore(saved, now)
  assert.equal(reloaded.points.size, 8196)
  const narrow = reloaded.snapshot(now, {
    view: { hours: 1, end: start + 3600000 },
    hideShortTasks: false
  })
  assert.equal(narrow.agents[0].segments[0].start, start)
  assert.equal(narrow.agents[0].segments[0].state, 'working')
  assert.equal(narrow.agents[0].segments[1].state, 'unknown')
  assert.equal(narrow.agents[0].segments[2].state, 'done')
  assert.equal(narrow.agents[0].omittedSegments, undefined)
  reloaded.point('newest', 'session', now - 1000, 'working', 'live', now)
  reloaded.prune(now)
  assert.equal(reloaded.points.size, 8196)
  assert.equal(reloaded.points.has('point-0'), false)
  assert.equal(reloaded.agents.get('session').incompleteActivityHistory, true)
})

test('corrupt or oversized compressed history fails within the decompression budget', () => {
  assert.throws(() => decodeRecorderCache({ version: 2 }, ['broken']))
  const bomb = deflateSync(' '.repeat(32 * 1024 * 1024 + 1)).toString('base64')
  assert.throws(() => decodeRecorderCache({ version: 2 }, [bomb]))
})
