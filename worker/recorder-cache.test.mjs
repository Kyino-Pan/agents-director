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
      i % 2 ? 'done' : 'working',
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

test('corrupt or oversized compressed history fails within the decompression budget', () => {
  assert.throws(() => decodeRecorderCache({ version: 2 }, ['broken']))
  const bomb = deflateSync(' '.repeat(32 * 1024 * 1024 + 1)).toString('base64')
  assert.throws(() => decodeRecorderCache({ version: 2 }, [bomb]))
})
