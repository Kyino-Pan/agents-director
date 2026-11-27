import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { ActivityStore, WINDOW_MS } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'
import { createPublicNavigator } from './public-navigation.mjs'
import activate, { deactivate, STORAGE_PREFIX } from './main.mjs'
import { encodeRecorderCache } from './recorder-cache.mjs'
import { denseRecorder, fixtureNow } from './snapshot-budget.fixture.mjs'

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
          return {
            workspaces: structuredClone(f.workspaces),
            truncated: f.workspaceTruncated || false
          }
        case 'project.list':
          return {
            projects: [{ id: 'p', name: 'Public project', hostId: 'local' }],
            truncated: false
          }
        case 'agents.list':
          return { agents: structuredClone(f.rowsByWorkspace?.[params.workspaceId] ?? f.rows) }
        case 'terminal.list':
          return {
            terminals: f.terminals ?? [
              ...f.rows.filter((row) => row.terminalId).map((row) => ({ id: row.terminalId })),
              { id: 'resumed' }
            ],
            truncated: false
          }
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

test('a same-session Working generation confirms its short gap in polls or events', async () => {
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
    const snapshot = f.store.snapshot(f.now)
    const live = [...f.store.points.values()].filter((p) => p.state === 'working')
    assert.equal(live.length, 1, mode)
    assert.equal(live[0].until, NOW + 5000, mode)
    assert.deepEqual(
      snapshot.agents[0].segments.filter((s) => s.state === 'working').map((s) => [s.start, s.end]),
      [[NOW, NOW + 5000]]
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
  await assert.rejects(f.navigate({ agentId: first }), /public session ID/)
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

test('navigation refuses conflicting terminal identities and unaddressable live sessions without resuming', async () => {
  for (const mode of ['same-provider', 'other-provider', 'duplicate-row', 'no-terminal']) {
    const f = fixture()
    f.rows = [{ ...row, agent: 'claude' }]
    await f.collector.scan()
    if (mode === 'no-terminal') f.rows[0].terminalId = null
    else
      f.rows.push({
        ...f.rows[0],
        agent: mode === 'other-provider' ? 'codex' : 'claude',
        sessionId: mode === 'duplicate-row' ? row.sessionId : 'different-session'
      })
    await assert.rejects(
      f.navigate({ agentId: f.agent().id }),
      mode === 'no-terminal'
        ? /not provided a terminal for this live session/
        : /conflicting public session identities|More than one terminal/,
      mode
    )
    assert.equal(
      f.calls.some((c) => c.method === 'agent.resume' || c.method === 'terminal.focus'),
      false,
      mode
    )
  }
})

test('Claude navigation uses the full identity in the original workspace, never a title or short ID', async () => {
  const f = fixture()
  const sessionId = '11111111-2222-4333-8444-5555aabbccdd'
  f.rows = [{ ...row, agent: 'claude', sessionId, title: 'Shared title' }]
  f.sessions = []
  await f.collector.scan()
  const agent = [...f.store.agents.values()].find((a) => a.sessionId === sessionId)
  const original = f.host.call
  f.host.call = (method, params) => {
    if (method === 'agents.list') {
      assert.equal(params.workspaceId, workspace.id)
      return Promise.resolve({
        agents: [
          { ...row, agent: 'codex', sessionId, terminalId: 'other-provider' },
          { ...row, agent: 'claude', sessionId: 'different-aabbccdd', terminalId: 'same-suffix' },
          { ...row, agent: 'claude', sessionId, terminalId: 'correct', title: 'New title' }
        ]
      })
    }
    if (method === 'terminal.list') return Promise.resolve({ terminals: [{ id: 'correct' }] })
    return original(method, params)
  }
  assert.equal((await f.navigate({ agentId: agent.id })).navigated, true)
  assert.deepEqual(f.calls.at(-1), { method: 'terminal.focus', params: { terminalId: 'correct' } })
  f.workspaces = [{ ...workspace, id: 'another-workspace', hostId: 'runtime:other' }]
  f.calls.length = 0
  await assert.rejects(f.navigate({ agentId: agent.id }), /original workspace is no longer/)
  assert.equal(
    f.calls.some((c) => c.method === 'terminal.focus' || c.method === 'agent.resume'),
    false
  )
})

function aliasFixture() {
  const f = fixture()
  const alias = { ...workspace, id: 'same-local-folder', hostId: null }
  f.workspaces = [workspace, alias]
  f.rows = [{ ...row, agent: 'claude' }]
  f.rowsByWorkspace = { [workspace.id]: f.rows, [alias.id]: [] }
  f.sessions = [{ ...saved, agent: 'claude', workspaceId: alias.id }]
  return { f, alias }
}

test('a previously observed Claude session can resume in its original workspace when history chose a local folder alias', async () => {
  const { f, alias } = aliasFixture()
  await f.collector.scan()
  assert.equal(f.agent().workspace, workspace.id)
  f.rowsByWorkspace[workspace.id] = []
  f.calls.length = 0
  assert.deepEqual(await f.navigate({ agentId: f.agent().id }), { navigated: true, started: true })
  assert.ok(f.calls.some((c) => c.method === 'agent.listSessions' && !c.params.workspaceId))
  assert.ok(f.calls.some((c) => c.method === 'agents.list' && c.params.workspaceId === alias.id))
  assert.deepEqual(f.calls.find((c) => c.method === 'agent.resume').params, {
    workspaceId: workspace.id,
    agent: 'claude',
    sessionId: row.sessionId
  })
  assert.deepEqual(f.calls.at(-2), {
    method: 'terminal.list',
    params: { workspaceId: workspace.id }
  })
  assert.deepEqual(f.calls.at(-1), { method: 'terminal.focus', params: { terminalId: 'resumed' } })
})

test('alias history never overrides missing origin evidence, host/path differences, duplicate IDs or a live owner elsewhere', async () => {
  for (const mode of [
    'history-only',
    'history-only-with-scoped-history',
    'different-path',
    'remote-alias',
    'changed-host',
    'unknown-workspace',
    'wrong-provider',
    'wrong-session',
    'wrong-history-host',
    'duplicate-history',
    'truncated-workspaces',
    'live-alias',
    'full-alias-inventory',
    'unreadable-alias'
  ]) {
    const { f, alias } = aliasFixture()
    await f.collector.scan()
    f.rowsByWorkspace[workspace.id] = []
    if (mode === 'history-only') delete f.agent().terminalHandle
    if (mode === 'history-only-with-scoped-history') {
      delete f.agent().terminalHandle
      f.sessions[0].workspaceId = workspace.id
    }
    if (mode === 'different-path') alias.path = '/another-folder'
    if (mode === 'remote-alias') alias.hostId = 'runtime:other'
    if (mode === 'changed-host') f.workspaces[0] = { ...workspace, hostId: 'runtime:other' }
    if (mode === 'unknown-workspace') f.sessions[0].workspaceId = 'missing'
    if (mode === 'wrong-provider') f.sessions[0].agent = 'codex'
    if (mode === 'wrong-session') f.sessions[0].sessionId = 'same-title-different-id'
    if (mode === 'wrong-history-host') f.sessions[0].hostId = 'runtime:other'
    if (mode === 'duplicate-history') f.sessions.push({ ...f.sessions[0] })
    if (mode === 'truncated-workspaces') f.workspaceTruncated = true
    if (mode === 'live-alias')
      f.rowsByWorkspace[alias.id] = [{ ...f.rows[0], terminalId: 'elsewhere' }]
    if (mode === 'full-alias-inventory')
      f.rowsByWorkspace[alias.id] = Array.from({ length: 50 }, (_, i) => ({
        ...row,
        sessionId: 'other-' + i,
        terminalId: 'other-' + i
      }))
    if (mode === 'unreadable-alias') {
      const call = f.host.call
      f.host.call = (method, params) => {
        if (method === 'agents.list' && params.workspaceId === alias.id)
          throw new Error('Unavailable')
        return call(method, params)
      }
    }
    f.calls.length = 0
    await assert.rejects(f.navigate({ agentId: f.agent().id }), undefined, mode)
    assert.equal(
      f.calls.some((c) => c.method === 'agent.resume' || c.method === 'terminal.focus'),
      false,
      mode
    )
  }
})

test('history-only sessions in unique workspaces remain resumable, but a capped live inventory cannot prove absence', async () => {
  const f = fixture()
  f.rows = []
  await f.collector.scan()
  assert.equal(f.agent().terminalHandle, undefined)
  assert.deepEqual(await f.navigate({ agentId: f.agent().id }), { navigated: true, started: true })
  f.rows = Array.from({ length: 50 }, (_, i) => ({ ...row, sessionId: 'other-' + i }))
  f.calls.length = 0
  await assert.rejects(f.navigate({ agentId: f.agent().id }), /complete agent inventory/)
  assert.equal(
    f.calls.some((c) => c.method === 'agent.resume' || c.method === 'terminal.focus'),
    false
  )
})

test('a resumed orphan, duplicate address or terminal outside the original workspace is never focused', async () => {
  for (const terminals of [
    [],
    [{ id: 'wrong-workspace-terminal' }],
    [{ id: 'resumed' }, { id: 'resumed' }]
  ]) {
    const f = fixture()
    await f.collector.scan()
    f.rows = []
    f.terminals = terminals
    await assert.rejects(f.navigate({ agentId: f.agent().id }), /did not list this terminal/)
    assert.equal(f.calls.filter((c) => c.method === 'agent.resume').length, 1)
    assert.equal(
      f.calls.some((c) => c.method === 'terminal.focus'),
      false
    )
  }
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
    hooks: { on: () => ({ dispose() {} }) },
    events: {
      on: (_name, callback) => {
        f.receive = callback
        return { dispose() {} }
      }
    },
    panels: { handle: (name, handler) => f.handlers.set(name, handler), post() {} },
    commands: { register: (name, handler) => f.handlers.set(name, handler) },
    storage: {
      keys: async () => [...f.storage.keys()],
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

test('worker requests budget each frame independently while legacy requests retain seven days', async () => {
  const f = workerFixture()
  const now = Date.now()
  const raw = denseRecorder().serialize()
  const offset = now - fixtureNow
  for (const point of raw.points) {
    point.at += offset
    if (Number.isFinite(point.until)) point.until += offset
  }
  for (const mail of raw.messages) mail.at += offset
  raw.collectingSince += offset
  raw.collectedUntil = now
  const chunks = encodeRecorderCache(raw)
  f.storage.clear()
  chunks.forEach((chunk, index) => f.storage.set(`${STORAGE_PREFIX}:a:${index}`, chunk))
  f.storage.set(`${STORAGE_PREFIX}:head`, { version: 2, generation: 'a', chunks: chunks.length })
  activate(f.api)
  try {
    const handler = f.handlers.get('activity.snapshot')
    const [side, editor] = await Promise.all([
      handler(
        { hideShortTasks: false, view: { hours: 1 / 12, end: now } },
        { panel: { id: 'side' } }
      ),
      handler(
        { hideShortTasks: false, view: { hours: 1, end: now - 3600000 } },
        { panel: { id: 'editor' } }
      )
    ])
    assert.deepEqual(side.view, { start: now - 300000, end: now })
    assert.deepEqual(editor.view, { start: now - 7200000, end: now - 3600000 })
    assert.ok(side.agents.reduce((n, a) => n + a.segments.length, 0) < 4000)
    assert.ok(editor.agents.reduce((n, a) => n + a.segments.length, 0) < 4000)
    const legacy = await handler({ hideShortTasks: false })
    assert.equal(legacy.view, undefined)
    assert.equal(
      legacy.agents.reduce((n, a) => n + a.segments.length, 0),
      4000
    )
    assert.ok(legacy.agents.some((a) => a.omittedSegments))
  } finally {
    await deactivate()
  }
})

test('worker lifecycle persists only public observations and restores without bridging offline time', async () => {
  const f = workerFixture()
  f.storage.clear() // First install has neither a recorder head nor any preference keys.
  try {
    await activate(f.api)
    await f.handlers.get('activity.snapshot')({})
    assert.equal(f.storage.size, 0)
    await f.handlers.get('refresh')()
    assert.deepEqual([...f.storage.keys()].sort(), [
      `${STORAGE_PREFIX}:a:0`,
      `${STORAGE_PREFIX}:head`
    ])
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
    assert.equal(snapshot.sources.find((s) => s.name === 'Recorder cache').status, 'error')
  } finally {
    await deactivate()
  }
})

test('an upgrade near the host quota restores the committed public history across a failed write and retry', async () => {
  const f = workerFixture()
  const quota = 5 * 1024 * 1024
  const bytes = (data) => Buffer.byteLength(JSON.stringify(Object.fromEntries(data), null, 2))
  const key = (generation, index) => `${STORAGE_PREFIX}:${generation}:${index}`
  const headKey = `${STORAGE_PREFIX}:head`
  // Build a v0.2.0 snapshot independently of the new writer, close to its 1,800 KiB limit.
  const now = Date.now()
  const oldStore = new ActivityStore(now - 1000)
  const oldCollector = new PublicCollector(oldStore, {}, () => now)
  for (let i = 0; i < 2440; i++) {
    const identity = createHash('shake256', { outputLength: 255 })
      .update(String(i))
      .digest('base64')
    oldCollector.observe(
      workspace,
      {
        ...row,
        terminalId: `term-${i}`,
        title: identity.slice(0, 160),
        sessionId: identity.slice(160)
      },
      now
    )
  }
  const old = oldStore.serialize()
  const encoded = deflateSync(JSON.stringify(old)).toString('base64')
  assert.ok(encoded.length > 1750 * 1024 && encoded.length <= 1800 * 1024)
  const chunks = encoded.match(/.{1,24000}/g)
  const head = { version: 2, generation: 'a', chunks: chunks.length }
  chunks.forEach((chunk, i) => f.storage.set(key('a', i), chunk))
  f.storage.set(headKey, head)
  const preferences = new Map([
    ['view:window-hours', 72],
    ['activity-v1:preferences', { label: '自定义' }],
    [`${STORAGE_PREFIX}:b:notes`, 'keep']
  ])
  for (const [k, v] of preferences) f.storage.set(k, v)
  const legacy = JSON.stringify({ agents: [{ id: 'legacy', label: '"'.repeat(400000) }] })
  const legacyChunks = legacy.match(/.{1,24000}/g)
  f.storage.set('activity-v1:head', { version: 1, generation: 'a', chunks: legacyChunks.length })
  legacyChunks.forEach((chunk, i) => f.storage.set(`activity-v1:a:${i}`, chunk))
  f.storage.set(key('a', chunks.length), 'old public tail')
  // Orphans left by the 0.2.0 writer. Stop within one chunk of Orca's file-size cap.
  for (let i = 0; i < chunks.length; i++) {
    f.storage.set(key('b', i), chunks[i])
    if (bytes(f.storage) > quota) {
      f.storage.delete(key('b', i))
      break
    }
  }
  assert.ok(bytes(f.storage) <= quota && bytes(f.storage) > quota - 25000)

  let offline = false
  let interrupt = true
  let failRead = false
  let peak = 0
  const online = () => {
    if (offline) throw new Error('Worker disconnected')
  }
  f.api.storage = {
    keys: async () => {
      online()
      return [...f.storage.keys()]
    },
    get: async (k) => {
      online()
      f.storageReads.push(k)
      if (failRead && k === key('a', 1)) throw new Error('Temporary read failure')
      return f.storage.get(k) ?? null
    },
    delete: async (k) => {
      online()
      f.storage.delete(k)
    },
    set: async (k, v) => {
      online()
      const next = new Map(f.storage).set(k, v)
      const size = bytes(next)
      assert.ok(next.size <= 1024 && Buffer.byteLength(JSON.stringify(v)) <= 256 * 1024)
      if (size > quota) throw new Error('Storage exceeds 5 MiB')
      peak = Math.max(peak, size)
      f.storage.set(k, v)
      if (interrupt && k === key('b', 2)) {
        offline = true
        throw new Error('Worker disconnected')
      }
    }
  }
  const committed = () => {
    const h = f.storage.get(headKey)
    const data = Array.from({ length: h.chunks }, (_, i) =>
      f.storage.get(key(h.generation, i))
    ).join('')
    return JSON.parse(inflateSync(Buffer.from(data, 'base64')))
  }
  const cacheStatus = async () =>
    (await f.handlers.get('activity.snapshot')({ hideShortTasks: false })).sources.find(
      (s) => s.name === 'Recorder cache'
    )
  try {
    await activate(f.api)
    assert.equal((await cacheStatus()).status, 'error')
    assert.deepEqual(f.storage.get(headKey), head)
    assert.deepEqual(committed(), old)
    assert.equal(f.storage.has('activity-v1:head'), false)
    assert.equal(f.storage.has('activity-v1:a:0'), false)
    assert.equal(f.storage.has(key('a', chunks.length)), false)
    assert.equal(f.storage.has(key('b', 2)), true)
    assert.equal(f.storage.has(key('b', 3)), false)
    await deactivate() // The disconnected worker cannot finish or clean up its write.

    offline = false
    interrupt = false
    // Reserve unrelated storage so that two generations just fit, then push them over quota.
    const twoGenerations = new Map(f.storage)
    chunks.forEach((chunk, i) => twoGenerations.set(key('b', i), chunk))
    let spare = quota - bytes(twoGenerations) - 16000
    for (let i = 0; spare > 0; i++) {
      const k = `unrelated:${i}`
      const length = Math.min(200000, spare)
      const value = 'x'.repeat(length)
      f.storage.set(k, value)
      preferences.set(k, value)
      spare -= length
    }
    f.storage.set('unrelated:pressure', 'x'.repeat(32000))
    failRead = true
    await activate(f.api)
    assert.match((await cacheStatus()).detail, /Temporary read failure/)
    const live = await f.handlers.get('activity.snapshot')({ hideShortTasks: false })
    assert.ok(live.agents.some((a) => a.sessionId === 's'))
    assert.deepEqual(committed(), old)
    failRead = false
    f.rows = []
    await f.handlers.get('refresh')()
    assert.match((await cacheStatus()).detail, /exceeds 5 MiB/)
    assert.deepEqual(committed(), old)
    assert.equal(f.storage.has(key('b', 0)), false)
    assert.equal(f.storage.get('unrelated:pressure').length, 32000)

    f.storage.delete('unrelated:pressure')
    await f.handlers.get('refresh')()
    assert.equal((await cacheStatus()).status, 'ok')
    assert.equal(f.storage.get(headKey).generation, 'b')
    const restored = committed()
    assert.deepEqual(
      restored.agents.filter((a) => a.sessionId !== 's'),
      old.agents
    )
    assert.deepEqual(
      restored.points.filter((p) => oldStore.points.has(p.id)),
      old.points
    )
    assert.ok(restored.agents.some((a) => a.sessionId === 's'))
    assert.equal(f.storage.has(key('a', 0)), false)
    assert.ok(peak > quota - 32000 && peak <= quota)
    assert.equal(
      f.storageReads.some((k) => k.startsWith('activity-v1:')),
      false
    )
    for (const [k, v] of preferences) assert.deepEqual(f.storage.get(k), v)
  } finally {
    await deactivate()
  }
})

for (const fault of [
  'initial head',
  'initial chunk',
  'pre-save head',
  'empty key lists',
  'known store reads empty'
]) {
  test(`a storage fault (${fault}) followed by a rejected write preserves the committed generation`, async () => {
    const f = workerFixture()
    const now = Date.now()
    const oldStore = new ActivityStore(now - 1000)
    new PublicCollector(oldStore, {}, () => now).observe(
      workspace,
      {
        ...row,
        sessionId: 'prior-session'
      },
      now
    )
    const old = oldStore.serialize()
    const headKey = `${STORAGE_PREFIX}:head`
    const chunkKey = `${STORAGE_PREFIX}:a:0`
    const head = { version: 2, generation: 'a', chunks: 1 }
    const chunk = deflateSync(JSON.stringify(old)).toString('base64')
    f.storage.set(headKey, head)
    f.storage.set(chunkKey, chunk)
    const storage = f.api.storage
    let headReads = 0
    let hideStorage = false
    let lostRead = false
    let rejectedWrite = false
    f.api.storage = {
      ...storage,
      keys: async () => {
        if (fault === 'known store reads empty' && headReads > 0 && !lostRead) {
          hideStorage = true
          lostRead = true
        }
        if (hideStorage) return []
        if (fault === 'empty key lists' && !lostRead) {
          lostRead = true
          return []
        }
        return storage.keys()
      },
      get: async (key) => {
        if (hideStorage) return null
        if (key === headKey) headReads++
        if (
          !lostRead &&
          ((fault === 'initial head' && key === headKey) ||
            (fault === 'initial chunk' && key === chunkKey) ||
            (fault === 'pre-save head' && key === headKey && headReads === 2))
        ) {
          lostRead = true
          return null // The public get result for a temporarily unreadable Orca KV file.
        }
        return storage.get(key)
      },
      set: async (key, value) => {
        assert.equal(
          hideStorage,
          false,
          'an empty read of known storage must never trigger a write'
        )
        if (lostRead && !rejectedWrite) {
          rejectedWrite = true
          throw new Error('Staged write rejected')
        }
        return storage.set(key, value)
      }
    }
    const assertCommitted = () => {
      assert.deepEqual(f.storage.get(headKey), head)
      assert.equal(f.storage.get(chunkKey), chunk)
    }
    try {
      await activate(f.api)
      const first = await f.handlers.get('activity.snapshot')({ hideShortTasks: false })
      assert.equal(first.sources.find((s) => s.name === 'Recorder cache').status, 'error')
      assert.ok(first.agents.some((a) => a.sessionId === 's'))
      assert.ok(lostRead)
      if (hideStorage) {
        await f.handlers.get('refresh')()
        assert.equal(rejectedWrite, false)
        hideStorage = false
      }
      assertCommitted()
      // This new observation is now available only in worker memory.
      f.rows = []
      f.sessions = []
      await f.handlers.get('refresh')()
      assert.ok(rejectedWrite)
      assertCommitted()
      await f.handlers.get('refresh')()
      const next = f.storage.get(headKey)
      assert.equal(next.generation, 'b')
      const saved = JSON.parse(
        inflateSync(Buffer.from(f.storage.get(`${STORAGE_PREFIX}:b:0`), 'base64'))
      )
      assert.deepEqual(
        new Set(saved.agents.map((agent) => agent.sessionId)),
        new Set(['prior-session', 's'])
      )
      assert.ok(saved.points.some((p) => p.id === old.points[0].id))
    } finally {
      await deactivate()
    }
  })
}

test('public status changes inside a tool turn become one recorded Working run', async () => {
  const f = fixture()
  await f.collector.scan()
  f.now += 5000
  await f.collector.scan()
  for (const [offset, state] of [
    [5043, 'waiting'],
    [6000, 'working'],
    [10000, 'working']
  ]) {
    f.now = NOW + offset
    f.collector.receive({
      workspaceListId: workspace.id,
      sessionId: row.sessionId,
      terminalId: row.terminalId,
      receivedAt: f.now,
      mainAgent: { state, stateStartedAt: NOW + (state === 'waiting' ? 5043 : 6000) }
    })
  }
  const segments = f.store.snapshot(f.now, { hideShortTasks: true }).agents[0].segments
  assert.deepEqual(
    segments.filter((s) => s.state === 'working').map((s) => [s.start - NOW, s.end - NOW, s.state]),
    [[0, 10000, 'working']]
  )
  assert.equal(
    [...f.store.points.values()].some((p) => p.state === 'waiting' && p.at === NOW + 5043),
    false
  )
  assert.equal(segments.at(-1).state, 'working')
})

test('retrying a failed head read combines live mailbox retrieval and saved relationships across restart', async () => {
  const f = workerFixture()
  const now = Date.now()
  const id = (session) => 'public:' + JSON.stringify([workspace.id, 'codex', session])
  const parent = id('parent'),
    child = id('child'),
    mailId = 'public-mail:msg_retry'
  const cache = new ActivityStore(now - 4000)
  f.rows = ['parent', 'child'].map((session) => ({
    ...row,
    sessionId: session,
    terminalId: 'term_' + session
  }))
  f.sessions = []
  for (const agent of f.rows) {
    cache.agent(id(agent.sessionId), {
      workspace: workspace.id,
      provider: agent.agent,
      sessionId: agent.sessionId
    })
    cache.point(
      'p' + agent.sessionId,
      id(agent.sessionId),
      now - 4000,
      'working',
      'live',
      now - 2000
    )
  }
  cache.agent(child, { parentId: parent, spawnedAt: now - 3000 })
  cache.message({ id: mailId, from: parent, to: child, type: 'Send accepted', at: now - 1500 })
  const key = STORAGE_PREFIX + ':head'
  f.storage.set(key, { version: 2, generation: 'a', chunks: 1 })
  f.storage.set(
    STORAGE_PREFIX + ':a:0',
    deflateSync(JSON.stringify(cache.serialize())).toString('base64')
  )
  const read = f.api.storage.get
  let fail = true
  f.api.storage.get = async (k) => {
    if (k === key && fail) {
      fail = false
      throw new Error('test head read failure')
    }
    return read(k)
  }
  const hooks = new Map()
  f.api.hooks.on = (name, handler) => {
    hooks.set(name, handler)
    return { dispose() {} }
  }
  try {
    activate(f.api)
    const snapshot = () => f.handlers.get('activity.snapshot')({ hideShortTasks: false })
    await snapshot()
    const event = {
      agent: 'codex',
      terminalId: 'term_child',
      callId: 'check',
      tool: 'Bash',
      input: { command: 'orca orchestration check --terminal term_child --json' }
    }
    hooks.get('agent.tool.before')(event)
    hooks.get('agent.tool.after')({
      ...event,
      output: JSON.stringify({ ok: true, result: { messages: [{ id: 'msg_retry' }] } })
    })
    assert.equal((await snapshot()).messages[0].from, null)
    await f.handlers.get('refresh')()
    for (const restart of [false, true]) {
      if (restart) {
        await deactivate()
        activate(f.api)
      }
      const data = await snapshot()
      const childRow = data.agents.find((a) => a.id === child)
      const mail = data.messages.find((m) => m.id === mailId)
      assert.deepEqual([childRow.parentId, childRow.spawnedAt], [parent, now - 3000])
      assert.deepEqual(
        [mail.from, mail.to, mail.type, mail.at],
        [parent, child, 'Mailbox received', now - 1500]
      )
      assert.ok(mail.deliveredAt >= now)
    }
  } finally {
    await deactivate()
  }
})

test('merging mail keeps the checked receiver and revokes contradictory senders', () => {
  const store = new ActivityStore()
  const input = {
    id: 'public-mail:msg_a',
    from: null,
    to: 'receiver',
    at: 20,
    deliveredAt: 20,
    type: 'Mailbox input'
  }
  const sent = { id: input.id, from: 'sender', to: 'receiver', at: 10, type: 'Send accepted' }
  for (const row of [input, sent, sent]) store.message(row)
  const merged = store.messages.get(input.id)
  assert.deepEqual([merged.at, merged.deliveredAt, merged.type], [10, 20, 'Mailbox received'])
  store.message({ ...sent, to: 'another', at: 1 })
  assert.deepEqual(store.messages.get(input.id), merged)
  store.message({ ...sent, from: 'other', at: 5 })
  const revoked = store.messages.get(input.id)
  assert.deepEqual(
    [revoked.from, revoked.to, revoked.type, revoked.at, revoked.deliveredAt],
    [null, 'receiver', 'Mailbox input', 20, 20]
  )
})

test('delayed recovery keeps parent and spawn time together across identity conflicts', () => {
  const live = new ActivityStore()
  const saved = new ActivityStore()
  live.agent('child', { sessionId: 's', workspace: 'w', parentId: 'new-parent', spawnedAt: 200 })
  saved.agent('child', {
    sessionId: 's',
    workspace: 'w',
    parentId: 'old-parent',
    spawnedAt: 100,
    totalTokens: 42
  })
  live.agent('ambiguous', { sessionId: 'new-session' })
  saved.agent('ambiguous', { sessionId: 'old-session' })
  saved.agent('other', { parentId: 'ambiguous', spawnedAt: 88 })
  saved.message({
    id: 'public-mail:msg_conflict',
    from: 'ambiguous',
    to: 'child',
    at: 77,
    type: 'Send accepted'
  })
  live.recover(saved)
  assert.deepEqual(
    [
      live.agents.get('child').parentId,
      live.agents.get('child').spawnedAt,
      live.agents.get('child').totalTokens
    ],
    ['new-parent', 200, 42]
  )
  assert.equal(live.agents.get('other').parentId, undefined)
  assert.equal(live.messages.size, 0)
})
