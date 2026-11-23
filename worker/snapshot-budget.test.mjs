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

test('retained pinned project headings page by UTF-8 size and stale partial results can be retried', async () => {
  const { createHeadingPages } = await import('./project-headings.mjs')
  const source = Array.from({ length: 1800 }, (_, n) => ({
    hostId: 'local',
    projectId: 'repo-' + n,
    projectName: '全部短任务'.repeat(60) + n
  }))
  const pages = createHeadingPages()
  const version = pages.update(source)
  assert.ok(version)
  assert.equal(pages.update(structuredClone(source)), version)
  const restored = []
  let index = 0
  for (; ; index++) {
    const page = pages.get({ version, index })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 129 * 1024)
    restored.push(...page.headings)
    if (!page.more) break
  }
  assert.ok(index > 1)
  assert.deepEqual(restored, source)
  assert.equal(pages.update([]), null)
  assert.deepEqual(pages.get({ version, index: 0 }), { stale: true })
})

test('optional snapshot fields stay absent on lanes, headings, messages and nested metadata', () => {
  const store = new ActivityStore(fixtureNow)
  store.agent('legacy', { projectId: 'p', memory: { samples: [{ bytes: 0, metric: undefined }] } })
  store.agent('other', { hostId: 'another-host', projectId: 'p' })
  store.point('one', 'legacy', fixtureNow - 100, 'working', undefined, fixtureNow)
  store.message({ id: 'mail', from: null, to: 'other', at: fixtureNow, deliveredAt: undefined })
  store.source('test', 'limited', undefined)
  const view = store.snapshot(fixtureNow, { pinnedProjects: [JSON.stringify(['', 'p'])] })
  const lane = view.agents.find((a) => a.id === 'legacy')
  assert.deepEqual(view.pinnedProjects, [{ projectId: 'p' }])
  assert.equal(Object.hasOwn(lane, 'hostId'), false)
  assert.equal(Object.hasOwn(lane, 'projectName'), false)
  assert.deepEqual(lane.memory, { samples: [{ bytes: 0 }] })
  assert.equal(Object.hasOwn(store.agents.get('legacy').memory.samples[0], 'metric'), true)
  assert.equal(view.messages[0].from, null)
  function check(value) {
    assert.notEqual(value, undefined)
    if (value !== null && typeof value === 'object') Object.values(value).forEach(check)
  }
  check(view)
})

test('clipped evidence is paired with the requesting frame and snapshot, including concurrent views', async () => {
  const { createOmissionReplies } = await import('./snapshot-omissions.mjs')
  const replies = createOmissionReplies()
  const first = denseRecorder().snapshot(fixtureNow)
  const other = { ...first, agents: [...first.agents].reverse() }
  const older = replies.prepare(first, 'panel')
  const sidebar = replies.prepare(first, 'panel')
  const editor = replies.prepare(other, 'editor')
  assert.deepEqual(replies.take('editor', sidebar.omissionToken), { stale: true })
  assert.deepEqual(replies.take('panel', older.omissionToken), { stale: true })
  const legacy = replies.prepare(first)
  for (const [index, agent] of legacy.agents.entries()) {
    assert.deepEqual(agent.omittedRanges, first.agents[index].omittedRanges)
    assert.equal(agent.omittedActivity, undefined)
  }
  for (const [frame, part, full] of [
    ['panel', sidebar, first],
    ['editor', editor, other]
  ]) {
    const { rows } = replies.take(frame, part.omissionToken)
    assert.ok(rows.length > 0)
    const restored = [...part.agents]
    for (const { index, ...metadata } of rows) {
      assert.equal(restored[index].omittedRanges, undefined)
      restored[index] = { ...restored[index], ...metadata }
    }
    assert.deepEqual(restored, full.agents)
    assert.deepEqual(replies.take(frame, part.omissionToken), { stale: true })
  }
})
