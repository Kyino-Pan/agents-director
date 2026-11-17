import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore, WINDOW_MS } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'
import { createPublicNavigator } from './public-navigation.mjs'
import activate, { deactivate, STORAGE_PREFIX } from './main.mjs'

const NOW = 1_800_000_000_000
const workspace = {
  id: 'public-workspace',
  name: 'Feature',
  projectId: 'p',
  hostId: 'local',
  path: '/work'
}
const row = {
  terminalId: 't',
  agent: 'codex',
  sessionId: 's',
  title: 'Conversation',
  state: 'working',
  stateStartedAt: NOW - 100000
}
const saved = {
  sessionId: 's',
  agent: 'codex',
  title: 'History title',
  workspaceId: workspace.id,
  hostId: 'local',
  createdAt: NOW - 3600000,
  updatedAt: NOW - 1000,
  running: false,
  messageCount: 4,
  totalTokens: 90
}
function fixture() {
  const f = {
    now: NOW,
    rows: [row],
    sessions: [saved],
    calls: [],
    workspaces: [workspace],
    fail: null
  }
  f.host = {
    call: async (method, params) => {
      f.calls.push({ method, params })
      if (f.fail === method) throw new Error('Unavailable')
      switch (method) {
        case 'workspace.list':
          return { workspaces: structuredClone(f.workspaces), truncated: false }
        case 'project.list':
          return {
            projects: [{ id: 'p', name: 'Public project', hostId: 'local' }],
            truncated: false
          }
        case 'agents.list':
          return { agents: structuredClone(f.rows) }
        case 'agent.listSessions':
          return { sessions: structuredClone(f.sessions), truncated: f.truncated || false }
        case 'agent.resume':
          return { terminalId: 'resumed', started: true }
        case 'terminal.focus':
          return { focused: true }
        default:
          throw new Error(`Forbidden method: ${method}`)
      }
    }
  }
  f.store = new ActivityStore(NOW)
  f.collector = new PublicCollector(f.store, f.host, () => f.now)
  f.agent = () => [...f.store.agents.values()].find((agent) => agent.sessionId === 's')
  f.navigate = createPublicNavigator(f.store, f.host)
  return f
}

test('public APIs seed named project lanes and history never becomes inferred work', async () => {
  const f = fixture()
  await f.collector.scan()
  f.now += 5000
  await f.collector.scan()
  const snapshot = f.store.snapshot(f.now)
  assert.equal(snapshot.agents.length, 1)
  const agent = snapshot.agents[0]
  assert.equal(agent.projectName, 'Public project')
  assert.equal(agent.sessionId, 's')
  assert.equal(agent.messageCount, 4)
  assert.deepEqual(
    agent.segments.filter((s) => s.state === 'working').map((s) => [s.start, s.end]),
    [[NOW, NOW + 5000]]
  )
  assert.ok(agent.segments.some((s) => s.state === 'unknown'))
  assert.deepEqual(snapshot.messages, [])
  assert.equal(f.calls.filter((c) => c.method === 'agent.listSessions').length, 1)
})

test('history summaries alone stay unknown even when running is true', async () => {
  const f = fixture()
  f.rows = []
  f.sessions[0] = { ...saved, running: true, updatedAt: NOW }
  await f.collector.scan()
  assert.ok(f.store.snapshot(NOW).agents[0].segments.every((s) => s.state === 'unknown'))
  assert.equal(f.collector.live.size, 0)
})

test('terminal reuse keeps distinct conversations and never extends the previous owner', async () => {
  const f = fixture()
  await f.collector.scan()
  f.now += 5000
  await f.collector.scan()
  f.rows = [{ ...row, sessionId: 'other' }]
  f.now += 5000
  await f.collector.scan()
  f.now += 5000
  await f.collector.scan()
  const old = f.store.snapshot(f.now).agents.find((a) => a.sessionId === 's')
  assert.equal(
    Math.max(...old.segments.filter((s) => s.state === 'working').map((s) => s.end)),
    NOW + 5000
  )
  assert.equal(f.store.agents.size, 2)
})

test('a new same-state generation in polls or events cannot bridge unobserved execution', async () => {
  for (const mode of ['poll', 'event']) {
    const f = fixture()
    f.rows = [{ ...row, stateStartedAt: NOW - 1000 }]
    await f.collector.scan()
    f.now += 1000
    await f.collector.scan()
    f.now += 4000
    if (mode === 'poll') {
      f.rows = [{ ...row, stateStartedAt: NOW + 4000 }]
      await f.collector.scan()
    } else {
      f.collector.receive({
        workspaceListId: workspace.id,
        terminalId: 't',
        sessionId: 's',
        state: 'working',
        receivedAt: f.now,
        mainAgent: { state: 'working', stateStartedAt: NOW + 4000 }
      })
    }
    const live = [...f.store.points.values()].filter((p) => p.state === 'working')
    assert.equal(live.length, 2, mode)
    assert.equal(live[0].until, NOW + 1000, mode)
    assert.equal(live[1].at, NOW + 5000, mode)
    assert.ok(
      f.store
        .snapshot(f.now)
        .agents[0].segments.some(
          (s) => s.state === 'unknown' && s.start <= NOW + 1000 && s.end >= NOW + 5000
        ),
      mode
    )
  }
})

test('moving history updates with nullable creation time never truncate observed work', async () => {
  const f = fixture()
  f.sessions = [{ ...saved, createdAt: null }]
  await f.collector.scan()
  for (let i = 1; i <= 6; i++) {
    f.now = NOW + i * 5000
    f.sessions = [{ ...saved, createdAt: null, updatedAt: f.now - 1000 }]
    await f.collector.scan()
  }
  let work = f.store.snapshot(f.now).agents[0].segments.filter((s) => s.state === 'working')
  assert.deepEqual(
    work.map((s) => [s.start, s.end]),
    [[NOW, NOW + 30000]]
  )
  f.now += 5000
  await f.collector.scan()
  work = f.store.snapshot(f.now).agents[0].segments.filter((s) => s.state === 'working')
  assert.deepEqual(
    work.map((s) => [s.start, s.end]),
    [[NOW, NOW + 35000]]
  )
  // A first history response arriving after work was already observed also stays behind it.
  const fresh = fixture()
  fresh.sessions = []
  await fresh.collector.scan()
  fresh.now += 5000
  fresh.sessions = [{ ...saved, createdAt: null, updatedAt: fresh.now - 1000 }]
  await fresh.collector.scan()
  await fresh.collector.history()
  assert.deepEqual(
    fresh.store
      .snapshot(fresh.now)
      .agents[0].segments.filter((s) => s.state === 'working')
      .map((s) => [s.start, s.end]),
    [[NOW, NOW + 5000]]
  )
})

test('missing terminals, failed scans and long poll gaps remain unknown', async () => {
  for (const mode of ['missing', 'error', 'workspace-error', 'gap']) {
    const f = fixture()
    await f.collector.scan()
    f.now += 5000
    await f.collector.scan()
    f.now += 5000
    if (mode === 'missing') f.rows = []
    if (mode === 'error') f.fail = 'agents.list'
    if (mode === 'workspace-error') f.fail = 'workspace.list'
    if (mode !== 'gap') await f.collector.scan()
    f.rows = [row]
    f.fail = null
    f.now += 30000
    await f.collector.scan()
    const points = [...f.store.points.values()].filter((p) => p.state === 'working')
    assert.equal(points.length, 2, mode)
    assert.equal(points[0].until, NOW + 5000, mode)
    assert.ok(
      f.store
        .snapshot(f.now)
        .agents[0].segments.some((s) => s.state === 'unknown' && s.end > NOW + 5000)
    )
  }
})

test('documented event routes update known identities and unknown sessions wait for listing', async () => {
  const f = fixture()
  await f.collector.scan()
  f.now += 1000
  f.collector.receive({
    workspaceListId: workspace.id,
    workspaceId: 'private-id',
    terminalId: 't',
    sessionId: 's',
    state: 'blocked',
    receivedAt: f.now
  })
  assert.equal([...f.collector.live.values()][0].state, 'blocked')
  const count = f.store.points.size
  f.collector.receive({
    workspaceId: 'private-id',
    terminalId: 't',
    sessionId: 's',
    state: 'done',
    receivedAt: f.now
  })
  assert.equal(f.store.points.size, count)
  f.collector.receive({
    workspaceListId: workspace.id,
    terminalId: 't',
    sessionId: 'unknown',
    state: 'working',
    receivedAt: f.now
  })
  assert.equal(f.collector.live.size, 0)
  assert.equal(f.store.agents.size, 1)
})

test('an event arriving during an older inventory response wins', async () => {
  const f = fixture()
  await f.collector.scan()
  const call = f.host.call
  f.host.call = async (method, params) => {
    if (method === 'agents.list') {
      f.now += 1000
      f.collector.receive({
        workspaceListId: workspace.id,
        terminalId: 't',
        sessionId: 's',
        state: 'waiting',
        receivedAt: f.now
      })
      return { agents: [row] }
    }
    return call(method, params)
  }
  await f.collector.scan()
  assert.equal([...f.collector.live.values()][0].state, 'waiting')
})

test('unknown terminal identities are not reused after closure or restart', async () => {
  const f = fixture()
  f.rows = [{ ...row, sessionId: null }]
  f.sessions = []
  await f.collector.scan()
  const first = [...f.store.agents.keys()][0]
  f.rows = []
  f.now += 5000
  await f.collector.scan()
  f.rows = [{ ...row, sessionId: null }]
  f.now += 5000
  await f.collector.scan()
  assert.equal(f.store.agents.size, 2)
  assert.notEqual([...f.collector.live.values()][0].agentId, first)
  await assert.rejects(f.navigate({ agentId: first }), /No public session identity/)
})

test('history failure and truncation are visible and summaries older than seven days are omitted', async () => {
  const f = fixture()
  f.rows = []
  f.fail = 'agent.listSessions'
  await f.collector.scan()
  assert.equal(f.store.sources.get('Session history').status, 'error')
  f.fail = null
  f.truncated = true
  f.now += 30000
  f.sessions.push({ ...saved, sessionId: 'old', updatedAt: NOW - WINDOW_MS - 1 })
  await f.collector.scan()
  assert.equal(f.store.sources.get('Session history').status, 'limited')
  assert.equal(f.store.agents.size, 1)
})

test('navigation rechecks public ownership and focuses the currently matching terminal', async () => {
  const f = fixture()
  await f.collector.scan()
  f.rows = [{ ...row, terminalId: 'new-terminal' }]
  const result = await f.navigate({ agentId: f.agent().id })
  assert.equal(result.navigated, true)
  assert.deepEqual(f.calls.at(-1), {
    method: 'terminal.focus',
    params: { terminalId: 'new-terminal' }
  })
  assert.equal(
    f.calls.some((c) => c.method === 'agent.resume'),
    false
  )
})

test('closed sessions resume through the public API with exact original identity and duplicate requests coalesce', async () => {
  const f = fixture()
  await f.collector.scan()
  f.rows = [{ ...row, sessionId: 'different-owner' }]
  const [a, b] = await Promise.all([
    f.navigate({ agentId: f.agent().id }),
    f.navigate({ agentId: f.agent().id })
  ])
  assert.deepEqual(a, b)
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'agent.resume'),
    [
      {
        method: 'agent.resume',
        params: { workspaceId: workspace.id, agent: 'codex', sessionId: 's' }
      }
    ]
  )
  assert.deepEqual(f.calls.at(-1), { method: 'terminal.focus', params: { terminalId: 'resumed' } })
})

test('missing workspace/history, ambiguous ownership and host denials never trigger fallback launches', async () => {
  for (const mode of ['workspace', 'history', 'ambiguous', 'denied']) {
    const f = fixture()
    await f.collector.scan()
    if (mode === 'workspace') f.workspaces = []
    if (mode === 'history') {
      f.rows = []
      f.sessions = [{ ...saved, workspaceId: 'wrong' }]
    }
    if (mode === 'ambiguous') f.rows = [row, { ...row, terminalId: 'duplicate' }]
    if (mode === 'denied') f.fail = 'agents.list'
    await assert.rejects(f.navigate({ agentId: f.agent().id }))
    assert.equal(
      f.calls.some((c) => c.method === 'agent.resume' || c.method === 'terminal.focus'),
      false,
      mode
    )
  }
})

test('focus cancellation and resume failure propagate without retrying another identity', async () => {
  const f = fixture()
  await f.collector.scan()
  const call = f.host.call
  f.host.call = (method, params) =>
    method === 'terminal.focus' ? Promise.resolve({ focused: false }) : call(method, params)
  assert.equal((await f.navigate({ agentId: f.agent().id })).navigated, false)
  f.rows = []
  f.fail = 'agent.resume'
  await assert.rejects(f.navigate({ agentId: f.agent().id }), /Unavailable/)
  assert.equal(f.calls.filter((c) => c.method === 'agent.resume').length, 1)
})

function workerFixture() {
  const f = fixture()
  f.handlers = new Map()
  f.storage = new Map([['activity-v1:head', { version: 2, generation: 'a', chunks: 1 }]])
  f.storageReads = []
  f.api = {
    host: f.host,
    events: {
      on: (_name, callback) => {
        f.receive = callback
        return { dispose() {} }
      }
    },
    panels: { handle: (name, handler) => f.handlers.set(name, handler), post() {} },
    commands: { register: (name, handler) => f.handlers.set(name, handler) },
    storage: {
      get: async (key) => {
        f.storageReads.push(key)
        return f.storage.get(key)
      },
      set: async (key, value) => {
        f.storage.set(key, value)
      },
      delete: async (key) => {
        f.storage.delete(key)
      }
    }
  }
  // Main uses wall time; keep the fixture's history current too.
  f.sessions = [{ ...saved, createdAt: Date.now() - 60000, updatedAt: Date.now() }]
  return f
}

test('worker lifecycle persists only public observations and restores without bridging offline time', async () => {
  const f = workerFixture()
  try {
    await activate(f.api)
    const inputs = await f.handlers.get('activity.inputs')({ agentId: 'anything' })
    assert.deepEqual(inputs.inputs, [])
    assert.equal(inputs.unavailable, true)
    assert.match(inputs.reason, /public plugin API/)
    const snapshot = await f.handlers.get('activity.snapshot')({ hideShortTasks: false })
    assert.ok(snapshot.agents.some((a) => a.sessionId === 's'))
    await deactivate()
    assert.equal(
      f.storageReads.some((key) => key.startsWith('activity-v1:')),
      false
    )
    assert.equal(f.storage.get(`${STORAGE_PREFIX}:head`).version, 2)
    f.rows = []
    await activate(f.api)
    const restored = await f.handlers.get('activity.snapshot')({ hideShortTasks: false })
    assert.ok(restored.agents.some((a) => a.sessionId === 's'))
    assert.ok(
      restored.agents
        .flatMap((a) => a.segments)
        .filter((s) => s.state === 'working')
        .every((s) => s.end <= restored.now)
    )
  } finally {
    await deactivate()
  }
})

test('corrupt public cache and denied host calls leave the worker responsive with coverage errors', async () => {
  const f = workerFixture()
  f.storage.set(`${STORAGE_PREFIX}:head`, { version: 2, generation: 'a', chunks: 1 })
  f.fail = 'workspace.list'
  try {
    await activate(f.api)
    const snapshot = await f.handlers.get('activity.snapshot')({})
    assert.deepEqual(snapshot.agents, [])
    assert.equal(snapshot.sources.find((s) => s.name === 'Workspaces').status, 'error')
    assert.equal(snapshot.sources.find((s) => s.name === 'Recorder cache').status, 'ok')
  } finally {
    await deactivate()
  }
})
