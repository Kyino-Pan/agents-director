import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityStore } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'
import { encodeRecorderCache, decodeRecorderCache } from './recorder-cache.mjs'
import { frozenWorkingRuns } from './working-runs.fixture.mjs'
import { segmentAt } from '../timeline-evidence.mjs'

const T = Date.parse('2026-11-27T06:00:00Z')
function example(gap, state = 'done', zero = false) {
  const store = new ActivityStore(T - 1000)
  store.agent('session', { sessionId: 'claude-session', provider: 'claude' })
  store.point('left', 'session', T, 'working', 'live', T + 60000)
  const start = T + 60000
  if (state !== 'gap')
    store.point(
      'middle',
      'session',
      start + (zero ? 1659 : 0),
      state,
      'live',
      zero ? start + 1659 : start + gap
    )
  store.point('right', 'session', start + gap, 'working', 'live', start + gap + 60000)
  return { store, end: start + gap + 60000, start }
}

test('frozen 4897 / 5278 ms Claude intervals become one stored and selectable Working record', () => {
  for (const sample of frozenWorkingRuns) {
    const store = new ActivityStore(sample.points[0][0])
    store.agent('frozen', { sessionId: sample.name, provider: 'claude' })
    sample.points.forEach(([at, until, state], i) =>
      store.point('observed-' + i, 'frozen', at, state, 'live', until)
    )
    const end = sample.points.at(-1)[1]
    const snapshot = store.snapshot(end)
    assert.deepEqual(snapshot.agents[0].segments, [
      { start: sample.points[0][0], end, state: 'working', source: 'live' }
    ])
    assert.equal(snapshot.agents[0].stateEvents, undefined)
    const saved = store.serialize()
    assert.equal(saved.points.length, 1)
    assert.equal(saved.points[0].state, 'working')
    assert.equal(saved.points[0].until - saved.points[0].at, end - sample.points[0][0])
    assert.deepEqual(store.serialize(), saved)
  }
})

test('29999 / 30000 / 30001 ms use actual Working boundaries across all ordinary intermediate states', () => {
  for (const gap of [29999, 30000, 30001]) {
    for (const state of ['done', 'unknown', 'waiting', 'blocked', 'gap']) {
      const { store, end, start } = example(gap, state)
      const lane = store.snapshot(end).agents[0]
      assert.equal(lane.segments.filter((s) => s.state === 'working').length, gap < 30000 ? 1 : 2)
      assert.equal(segmentAt(lane.segments, start + 1000).state === 'working', gap < 30000)
      assert.equal(
        store.serialize().points.some((p) => p.id === 'middle'),
        state !== 'gap' && gap >= 30000
      )
    }
    const { store, end, start } = example(gap, 'done', true)
    const lane = store.snapshot(end).agents[0]
    assert.equal(segmentAt(lane.segments, start + 2000).state === 'working', gap < 30000)
    assert.equal(lane.stateEvents?.some((e) => e.state === 'done') ?? false, gap >= 30000)
  }
})

test('continuous recorded duration decides the strict three-minute boundary', () => {
  for (const duration of [179999, 180000, 180001]) {
    const store = new ActivityStore(T)
    store.agent('lane', { sessionId: 'same' })
    const gap = 20000
    store.point('left', 'lane', T, 'working', 'live', T + 80000)
    store.point('done-middle', 'lane', T + 80000, 'done', 'live', T + 100000)
    store.point('right', 'lane', T + 80000 + gap, 'working', 'live', T + duration)
    store.point('done-tail', 'lane', T + duration, 'done', 'live', T + duration + 1000)
    const full = store.snapshot(T + duration + 1000)
    const work = full.agents[0].segments.find((s) => s.state === 'working')
    assert.equal(work.end - work.start, duration)
    const filtered = store.snapshot(T + duration + 1000, { hideShortTasks: true })
    assert.equal(filtered.hiddenShortTasks, duration < 180000 ? 1 : 0)
    assert.equal(filtered.agents.length, duration < 180000 ? 0 : 1)
    assert.equal(full.agents[0].segments.at(-1).state, 'done')
  }
})

test('unknown identities, missing Working bounds and true tail Done remain separate', () => {
  for (const missing of ['identity', 'left', 'right', 'end']) {
    const { store, end } = example(4897)
    if (missing === 'identity') delete store.agents.get('session').sessionId
    if (missing === 'left') store.points.delete('left')
    if (missing === 'right') store.points.delete('right')
    if (missing === 'end') delete store.points.get('left').until
    const saved = store.serialize()
    assert.ok(saved.points.some((p) => p.id === 'middle'))
    assert.ok(store.snapshot(end).agents[0].segments.some((s) => s.state !== 'working'))
  }
  const { store, end } = example(4897)
  store.point('tail', 'session', end, 'done', 'live', end + 60000)
  const lane = store.snapshot(end + 60000).agents[0]
  assert.equal(lane.segments.at(-1).state, 'done')
  assert.equal(lane.segments.at(-1).start, end)
})

test('v2 restore and delayed history normalize in place without a parallel raw archive', () => {
  const { store, end, start } = example(5278)
  store.agent('unrelated', { sessionId: 'other' })
  store.point('other', 'unrelated', T, 'blocked', 'live', end)
  store.message({
    id: 'public-mail:sample',
    from: 'session',
    to: 'unrelated',
    at: start + 1000,
    deliveredAt: start + 2000,
    type: 'Mailbox received'
  })
  const old = {
    agents: [...store.agents.values()],
    aliases: [],
    points: [...store.points.values()],
    messages: [...store.messages.values()],
    collectingSince: T,
    collectedUntil: end
  }
  const restored = new ActivityStore(end)
  restored.restore(decodeRecorderCache({ version: 2 }, encodeRecorderCache(old)), end)
  const saved = restored.serialize()
  assert.equal(saved.points.filter((p) => p.agentId === 'session').length, 1)
  assert.deepEqual(
    saved.points.find((p) => p.id === 'other'),
    old.points.find((p) => p.id === 'other')
  )
  assert.deepEqual(saved.messages, old.messages)
  const history = new ActivityStore(end)
  history.restore(old, end)
  restored.recover(history)
  restored.point('late-done', 'session', start + 2500, 'done', 'live', start + 2500)
  restored.point('late-work', 'session', T - 1000, 'working', 'live', T)
  const first = restored.serialize()
  const again = new ActivityStore(end)
  again.restore(decodeRecorderCache({ version: 2 }, encodeRecorderCache(first)), end)
  assert.deepEqual(again.serialize(), first)
  assert.equal(first.points.filter((p) => p.agentId === 'session').length, 1)
  assert.equal(first.points.find((p) => p.agentId === 'session').at, T - 1000)
  const lane = again.snapshot(end).agents.find((a) => a.id === 'session')
  assert.equal(segmentAt(lane.segments, start + 1000).state, 'working')
  assert.equal(again.messages.get('public-mail:sample').at, start + 1000)
})

function collectorFixture(store = new ActivityStore(T), now = T) {
  const f = { now, state: 'working', session: 'A' }
  const workspace = { id: 'workspace', hostId: 'local', name: 'Public workspace' }
  const host = {
    async call(method) {
      if (method === 'workspace.list') return { workspaces: [workspace] }
      if (method === 'project.list') return { projects: [] }
      if (method === 'agent.listSessions') return { sessions: [] }
      if (method === 'agents.list')
        return {
          agents: [
            { terminalId: 'terminal', agent: 'claude', sessionId: f.session, state: f.state }
          ]
        }
      throw Error(method)
    }
  }
  f.store = store
  f.collector = new PublicCollector(store, host, () => f.now)
  f.poll = async (at, state = f.state, session = f.session) => {
    f.now = at
    f.state = state
    f.session = session
    await f.collector.scan()
  }
  return f
}

test('live collection waits for right Working, follows the merged point and preserves the final Done', async () => {
  const f = collectorFixture()
  await f.poll(T)
  await f.poll(T + 5000)
  await f.poll(T + 7000, 'done')
  await f.poll(T + 10000)
  let lane = f.store.snapshot(f.now).agents[0]
  assert.equal(lane.segments.find((s) => s.state === 'working').end, T + 5000)
  assert.equal(lane.segments.at(-1).state, 'done')
  await f.poll(T + 34999, 'working')
  await f.poll(T + 39999)
  lane = f.store.snapshot(f.now).agents[0]
  assert.deepEqual(lane.segments, [{ start: T, end: T + 39999, state: 'working', source: 'live' }])
  assert.equal(f.store.serialize().points.length, 1)
  await f.poll(T + 42000, 'done')
  await f.poll(T + 75000)
  assert.equal(
    f.store.snapshot(f.now).agents[0].segments.find((s) => s.state === 'working').end,
    T + 39999
  )
  assert.ok(f.store.serialize().points.some((p) => p.state === 'done' && p.at === T + 42000))
})

test('normal restart only confirms a sub-30-second gap after a new Working observation', async () => {
  for (const gap of [29999, 30000, 30001]) {
    const f = collectorFixture()
    await f.poll(T)
    await f.poll(T + 5000)
    f.store.collectedUntil = T + 5000
    const saved = decodeRecorderCache({ version: 2 }, encodeRecorderCache(f.store.serialize()))
    const restored = new ActivityStore(T + 5000 + gap)
    restored.restore(saved, T + 5000 + gap)
    assert.equal(
      restored.snapshot(T + 5000 + gap).agents[0].segments.find((s) => s.state === 'working').end,
      T + 5000
    )
    const resumed = collectorFixture(restored, T + 5000 + gap)
    await resumed.poll(T + 5000 + gap)
    await resumed.poll(T + 10000 + gap)
    const lane = resumed.store.snapshot(resumed.now).agents[0]
    assert.equal(lane.segments.filter((s) => s.state === 'working').length, gap < 30000 ? 1 : 2)
  }
})

test('a legacy live point without a bounded end cannot establish a short-gap merge after restore', () => {
  const store = new ActivityStore(T)
  store.restore(
    {
      agents: [{ id: 'legacy', sessionId: 'legacy' }],
      points: [{ id: 'old', agentId: 'legacy', at: T, state: 'working', source: 'live' }],
      collectedUntil: T + 5000
    },
    T + 10000
  )
  store.point('new', 'legacy', T + 10000, 'working', 'live', T + 15000)
  const lane = store.snapshot(T + 15000).agents[0]
  assert.equal(lane.segments.filter((s) => s.state === 'working').length, 2)
  assert.equal(store.serialize().points.find((p) => p.id === 'old').until, T + 5000)
})

test('legacy Done without an explicit end is absorbed when both Working bounds are reliable', () => {
  const { store, end } = example(5278)
  const saved = {
    agents: [...store.agents.values()],
    points: [...store.points.values()],
    collectedUntil: end
  }
  delete saved.points.find((p) => p.id === 'middle').until
  const restored = new ActivityStore(end)
  restored.restore(saved, end)
  assert.equal(restored.serialize().points.length, 1)
  assert.equal(restored.snapshot(end).agents[0].segments[0].end, end)
})

test('ordinary terminal A to B to A reuse cannot merge across a changed session identity', async () => {
  const f = collectorFixture()
  await f.poll(T)
  await f.poll(T + 5000)
  await f.poll(T + 10000, 'working', 'B')
  await f.poll(T + 15000)
  await f.poll(T + 20000, 'working', 'A')
  await f.poll(T + 25000)
  const lane = f.store.snapshot(f.now).agents.find((a) => a.sessionId === 'A')
  assert.deepEqual(
    lane.segments.filter((s) => s.state === 'working').map((s) => [s.start, s.end]),
    [
      [T, T + 5000],
      [T + 20000, T + 25000]
    ]
  )
  const restored = new ActivityStore(f.now)
  restored.restore(
    decodeRecorderCache({ version: 2 }, encodeRecorderCache(f.store.serialize())),
    f.now
  )
  assert.equal(
    restored
      .snapshot(f.now)
      .agents.find((a) => a.sessionId === 'A')
      .segments.filter((s) => s.state === 'working').length,
    2
  )
})

test('a delayed prior-session event cannot fence the current session run', async () => {
  const f = collectorFixture()
  await f.poll(T)
  await f.poll(T + 5000)
  await f.poll(T + 10000, 'working', 'B')
  await f.poll(T + 15000)
  f.now = T + 16000
  f.collector.receive({
    workspaceListId: 'workspace',
    terminalId: 'terminal',
    sessionId: 'A',
    receivedAt: T + 7000,
    mainAgent: { state: 'done' }
  })
  await f.poll(T + 20000)
  await f.poll(T + 21000, 'done')
  await f.poll(T + 25000, 'working')
  const lane = f.store.snapshot(f.now).agents.find((a) => a.sessionId === 'B')
  assert.deepEqual(
    lane.segments.filter((s) => s.state === 'working').map((s) => [s.start, s.end]),
    [[T + 10000, T + 25000]]
  )
})

test('a new session identity fence does not count as an execution hole at the run start', async () => {
  const f = collectorFixture()
  await f.poll(T)
  await f.poll(T + 5000)
  await f.poll(T + 10000, 'working', 'B')
  await f.poll(T + 15000)
  await f.poll(T + 15000, 'done')
  await f.poll(T + 20000)
  const filtered = f.store.snapshot(f.now, { hideShortTasks: true })
  assert.equal(
    filtered.agents.some((a) => a.sessionId === 'B'),
    false
  )
})

test('mail keeps exact send and retrieval times while endpoints follow the normalized run and tail Done', () => {
  const { store, end, start } = example(5278)
  store.point('tail', 'session', end, 'done', 'live', end + 5000)
  store.agent('peer', { sessionId: 'peer' })
  store.point('peer-work', 'peer', T, 'working', 'live', end + 5000)
  const mails = [
    {
      id: 'public-mail:middle',
      from: 'session',
      to: 'peer',
      at: start + 1000,
      deliveredAt: start + 2000,
      type: 'Mailbox received',
      subject: '',
      body: ''
    },
    {
      id: 'public-mail:tail',
      from: 'session',
      to: 'peer',
      at: end + 1000,
      deliveredAt: end + 2000,
      type: 'Mailbox received',
      subject: '',
      body: ''
    }
  ]
  for (const mail of mails) store.message(mail)
  const snapshot = store.snapshot(end + 5000)
  assert.deepEqual(snapshot.messages, mails)
  const lane = snapshot.agents.find((a) => a.id === 'session')
  assert.equal(segmentAt(lane.segments, mails[0].at).state, 'working')
  assert.equal(segmentAt(lane.segments, mails[1].at).state, 'done')
  assert.equal(segmentAt(lane.segments, mails[1].at).completionSince, end)
  assert.equal(store.serialize().points.filter((p) => p.state === 'done').length, 1)
})
