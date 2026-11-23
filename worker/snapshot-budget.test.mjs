import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityStore } from './activity-store.mjs'
import { denseRecorder, fixtureNow } from './snapshot-budget.fixture.mjs'

test('use the full shared budget, including for a single history above 600 segments', () => {
  for (const [demand, expected] of [
    [[600], [600]],
    [[602], [602]],
    [[800], [800]],
    [[3999], [3999]],
    [[4000], [4000]],
    [[4001], [4000]],
    [
      [800, 3200],
      [800, 3200]
    ],
    [
      [800, 3201],
      [800, 3200]
    ],
    [
      [1, 2200, 2400],
      [1, 1999, 2000]
    ]
  ]) {
    const store = new ActivityStore(fixtureNow)
    demand.forEach((count, lane) => {
      const points = Math.ceil(count / 2)
      for (let i = 0; i < points; i++) {
        const at = fixtureNow - (points - i) * 60000
        // Normally one working interval and one gap. End at now for an odd total.
        const until = count % 2 && i === points - 1 ? fixtureNow : at + 30000
        store.point(`${lane}-${i}`, String(lane), at, 'working', 'live', until)
      }
    })
    const view = store.snapshot(fixtureNow, { hideShortTasks: false })
    assert.deepEqual(
      view.agents.map((lane) => lane.segments.length),
      expected
    )
    assert.equal(view.limited, demand.reduce((sum, count) => sum + count, 0) > 4000)
    view.agents.forEach((lane, i) => {
      assert.equal(lane.omittedSegments ?? 0, demand[i] - expected[i])
      assert.equal(Boolean(lane.omittedRanges), expected[i] < demand[i])
    })
  }
})

test('dense lanes share the remaining budget after sparse histories and mail-only endpoints', () => {
  const store = denseRecorder()
  const raw = store.serialize()
  const snapshot = store.snapshot(fixtureNow)
  const lanes = snapshot.agents
  assert.equal(lanes.length, 54)
  assert.equal(
    lanes.reduce((count, lane) => count + lane.segments.length, 0),
    4000
  )
  assert.deepEqual(
    lanes.filter((a) => !a.segments.length).map((a) => a.id),
    ['Mailbox']
  )
  const counts = lanes.filter((a) => a.omittedSegments).map((a) => a.segments.length)
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1)
  assert.equal(snapshot.limited, true)
  assert.deepEqual(
    snapshot.messages.filter((m) => m.at >= fixtureNow - 300000).map(({ from, to }) => [from, to]),
    [
      ['Coordinator', 'Worker'],
      ['Reviewer', 'Coordinator'],
      [null, 'Mailbox']
    ]
  )
  for (const lane of lanes.filter((a) => a.segments.length)) {
    const single = new ActivityStore()
    single.restore({ ...raw, points: raw.points.filter((p) => p.agentId === lane.id) }, fixtureNow)
    const isolated = single.snapshot(fixtureNow).agents.find((a) => a.id === lane.id)
    assert.deepEqual(lane.segments, isolated.segments.slice(-lane.segments.length))
    const omitted = isolated.segments.length - lane.segments.length
    assert.equal(lane.omittedSegments ?? 0, omitted)
    assert.deepEqual(
      lane.omittedRanges,
      omitted
        ? [
            {
              start: isolated.segments[0].start,
              end: isolated.segments[omitted - 1].end
            }
          ]
        : undefined
    )
  }
  assert.deepEqual(store.serialize(), raw)
})

test('old send and late retrieval retain exact intervals, holes and direction in a dense snapshot', () => {
  const store = denseRecorder()
  const start = fixtureNow - 400 * 60000
  // A half-open boundary at the receiver, retrieved after it starts working.
  store.point('waiting', 'Receiver', start, 'waiting', 'live', start + 500)
  store.point('working', 'Receiver', start + 1000, 'working', 'live', start + 1150)
  const at = start + 500
  const deliveredAt = start + 1100
  const id = 'public-mail:reordered'
  store.message({
    id,
    from: null,
    to: 'Receiver',
    at: deliveredAt,
    deliveredAt,
    type: 'Mailbox input'
  })
  store.message({ id, from: 'Coordinator', to: 'Receiver', at, type: 'Send accepted' })
  store.message({
    id: 'reply',
    from: 'Receiver',
    to: 'Coordinator',
    at: start + 120050,
    type: 'Send accepted'
  })
  const snapshot = store.snapshot(fixtureNow)
  const message = snapshot.messages.find((m) => m.id === id)
  assert.deepEqual(
    [message.from, message.to, message.at, message.deliveredAt],
    ['Coordinator', 'Receiver', at, deliveredAt]
  )
  const sender = snapshot.agents.find((a) => a.id === 'Coordinator')
  const receiver = snapshot.agents.find((a) => a.id === 'Receiver')
  const observed = (lane, t) => lane.segments.find((s) => s.start <= t && t < s.end)
  assert.deepEqual(observed(sender, at), {
    state: 'working',
    source: 'live',
    start,
    end: start + 30000
  })
  assert.equal(observed(receiver, at).state, 'unknown')
  assert.equal(observed(receiver, deliveredAt).state, 'working')
  assert.equal(observed(sender, start + 120050).state, 'working')
  assert.equal(observed(sender, start + 60000), undefined)
  assert.deepEqual(sender.omittedRanges[0], { start: start + 30000, end: start + 120000 })
  assert.equal(sender.segments.at(-1).end, fixtureNow)
  assert.equal(
    snapshot.agents.reduce((n, a) => n + a.segments.length, 0),
    4000
  )
})

test('endpoint reservations can exceed a fair share without joining across an omission', () => {
  const store = new ActivityStore(fixtureNow)
  const start = fixtureNow - 10000
  for (let lane = 0; lane < 20; lane++) {
    for (let i = 0; i < 240; i++) {
      const at = start + i * 40
      store.point(lane + '-' + i, String(lane), at, 'working', 'live', at + 10)
    }
  }
  // Pin each short gap from lane 0 without pinning the surrounding work.
  for (let i = 0; i < 235; i++)
    store.message({
      id: 'gap-' + i,
      from: '0',
      to: 'Mailbox',
      at: start + i * 40 + 10,
      type: 'Send accepted'
    })
  const snapshot = store.snapshot(fixtureNow)
  const dense = snapshot.agents.find((a) => a.id === '0')
  assert.ok(dense.segments.length > 200)
  for (let i = 0; i < 235; i++) {
    const gap = dense.segments.find((s) => s.start === start + i * 40 + 10)
    assert.equal(gap.state, 'unknown')
    assert.equal(gap.joinedWork, undefined)
  }
  assert.ok(
    snapshot.agents
      .filter((a) => a.id !== 'Mailbox')
      .every((a) => a.segments.at(-1).end === fixtureNow)
  )
  assert.equal(
    snapshot.agents.reduce((n, a) => n + a.segments.length, 0),
    4000
  )
})
