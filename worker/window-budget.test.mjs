import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityStore } from './activity-store.mjs'
import { segmentAt } from '../timeline-evidence.mjs'
import { denseRecorder, fixtureNow as now } from './snapshot-budget.fixture.mjs'

test('viewport work fits before allocating the segment budget across older history', () => {
  const store = denseRecorder()
  const original = store.serialize()
  const view = { hours: 1 / 12, end: null }
  const snapshot = store.snapshot(now, { view })
  const legacy = store.snapshot(now)
  assert.equal(
    legacy.agents.reduce((n, a) => n + a.segments.length, 0),
    4000
  )
  assert.equal(legacy.view, undefined)
  assert.deepEqual(snapshot.view, { start: now - 300000, end: now })
  assert.ok(snapshot.agents.reduce((n, a) => n + a.segments.length, 0) < 4000)
  assert.equal(snapshot.limited, false)
  assert.equal(
    snapshot.agents.some((a) => a.omittedSegments),
    false
  )
  for (const lane of snapshot.agents) {
    const single = new ActivityStore(now)
    single.restore(
      {
        ...original,
        agents: [store.agents.get(lane.id)],
        messages: [],
        points: original.points.filter((p) => p.agentId === lane.id)
      },
      now
    )
    const expected = (single.snapshot(now).agents[0]?.segments ?? []).filter(
      (s) => s.end > snapshot.view.start && s.start < snapshot.view.end
    )
    assert.deepEqual(
      lane.segments.filter((s) => s.end > snapshot.view.start && s.start < snapshot.view.end),
      expected
    )
  }
  assert.deepEqual(store.serialize(), original)
  assert.ok(snapshot.messages.every((m) => m.at >= snapshot.view.start))
})

test('viewport edges keep exact state, short-gap proof, completion boundaries and later mail retrieval', () => {
  for (const gap of [29999, 30000, 30001]) {
    const store = new ActivityStore(now)
    const end = now - 10000
    store.agent('sender', { sessionId: 's' })
    store.point('work-left', 'sender', end - gap - 10000, 'working', 'live', end - gap)
    store.point('work-right', 'sender', end, 'working', 'live', end + 3000)
    store.point('done', 'sender', end + 3000, 'done', 'live', end + 3000)
    store.point('work-after-done', 'sender', end + 3001, 'working', 'live', now)
    store.point('receiver', 'receiver', end + 2000, 'waiting', 'live', now)
    store.message({
      id: 'crossing-mail',
      from: 'sender',
      to: 'receiver',
      at: end - 50,
      deliveredAt: end + 2500,
      type: 'Mailbox received'
    })
    const legacy = store.snapshot(now)
    const clipped = store.snapshot(now, { view: { hours: 100 / 3600000, end } })
    const lane = clipped.agents.find((a) => a.id === 'sender')
    const previous = legacy.agents.find((a) => a.id === 'sender')
    assert.deepEqual(segmentAt(lane.segments, end - 50), segmentAt(previous.segments, end - 50))
    assert.equal(Boolean(segmentAt(lane.segments, end - 50).joinedWork), gap < 30000)
    assert.equal(
      segmentAt(clipped.agents.find((a) => a.id === 'receiver').segments, end + 2500).state,
      'waiting'
    )
    const acrossDone = store
      .snapshot(now, { view: { hours: 0.001, end: end + 3500 } })
      .agents.find((a) => a.id === 'sender')
    assert.ok(acrossDone.stateEvents.some((e) => e.state === 'done' && e.at === end + 3000))
    assert.equal(segmentAt(acrossDone.segments, end + 3000).joinedWork, undefined)
    assert.equal(segmentAt(acrossDone.segments, end + 3001).state, 'working')
  }
})

test('over-budget viewports remain fair, bounded, and mark exact omissions without mutating history', () => {
  const store = new ActivityStore(now)
  for (let lane = 0; lane < 4; lane++) {
    store.agent(String(lane), { sessionId: 's' + lane })
    for (let i = 0; i < 600; i++) {
      const at = now - 60000 + i * 100
      store.point(lane + '-' + i, String(lane), at, 'working', 'live', at + 20)
    }
  }
  const original = store.serialize()
  const snapshot = store.snapshot(now, { view: { hours: 1 / 60, end: null } })
  assert.equal(
    snapshot.agents.reduce((n, a) => n + a.segments.length, 0),
    4000
  )
  assert.deepEqual(
    snapshot.agents.map((a) => a.segments.length),
    [1000, 1000, 1000, 1000]
  )
  assert.equal(snapshot.limited, true)
  for (const lane of snapshot.agents) {
    assert.equal(lane.omittedSegments, 200)
    assert.ok(lane.omittedActivity.length)
    assert.deepEqual(lane.omittedRanges, [{ start: now - 60000, end: now - 50000 }])
    assert.equal(lane.segments.at(-1).end, now)
  }
  assert.deepEqual(store.serialize(), original)
  for (const view of [undefined, {}, { hours: 0 }, { hours: 1, end: 'yesterday' }])
    assert.equal(store.snapshot(now, { view }).view, undefined)
})
