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
      assert.equal(Boolean(lane.omittedRange), expected[i] < demand[i])
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
      lane.omittedRange,
      omitted
        ? {
            start: isolated.segments[0].start,
            end: isolated.segments[omitted - 1].end
          }
        : undefined
    )
  }
  assert.deepEqual(store.serialize(), raw)
})
