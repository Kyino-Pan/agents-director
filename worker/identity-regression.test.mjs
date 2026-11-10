import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader, importStatusRow, defaultDataDirectory } from './orca-log-reader.mjs'
import { bindStructuredPane, SessionRouting } from './session-routing.mjs'
import { TerminalMemory } from './terminal-memory.mjs'

const NOW = Date.parse('2026-11-03T08:00:00Z')
const iso = (offset) => new Date(NOW + offset).toISOString()

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'activity-identity-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const db = new DatabaseSync(join(directory, 'orchestration.db'))
  context.after(() => db.close())
  db.exec(`CREATE TABLE runs (id TEXT, objective TEXT, coordinator_handle TEXT,
    coordinator_pane_key TEXT, coordinator_orca_session_id TEXT, created_at TEXT);
    CREATE TABLE dispatch_contexts (id TEXT, run_id TEXT, task_id TEXT, status TEXT,
    creator_dispatch_id TEXT, creator_handle TEXT, creator_pane_key TEXT, creator_orca_session_id TEXT,
    assignee_handle TEXT, assignee_pane_key TEXT, assignee_orca_session_id TEXT,
    dispatched_at TEXT, completed_at TEXT, created_at TEXT);
    CREATE TABLE worker_dispatches (dispatch_id TEXT, worktree_id TEXT, agent_terminal_handle TEXT);
    CREATE TABLE tasks (id TEXT, display_name TEXT);
    CREATE TABLE messages (id TEXT, from_handle TEXT, to_handle TEXT, sender_pane_key TEXT,
    created_at TEXT, sequence INTEGER);`)
  await mkdir(join(directory, 'agent-hooks'))
  await writeFile(join(directory, 'agent-hooks/last-status.json'), '{"entries":{}}')
  return { directory, db }
}

function status(store, id, offset, pane = 'pane') {
  importStatusRow(
    store,
    pane,
    {
      receivedAt: NOW + offset,
      terminalHandle: `term:${pane}`,
      providerSession: { agent: 'codex', id },
      payload: { state: 'working' }
    },
    NOW
  )
  return `native:codex:${id}`
}

test('failed launches stay out of lanes after restore, while retries and real failed workers survive', async (context) => {
  const { directory, db } = await fixture(context)
  db.exec("INSERT INTO tasks VALUES ('task', 'Source version worker')")
  const insert = db.prepare(`INSERT INTO dispatch_contexts
    (id, run_id, task_id, status, creator_handle, assignee_handle, dispatched_at, completed_at, created_at)
    VALUES (?, 'run', 'task', ?, 'parent', ?, ?, ?, ?)`)
  for (const [id, state, handle] of [
    ['ghost', 'failed', null],
    ['circuit', 'circuit_broken', null],
    ['retry', 'dispatched', 'real-one'],
    ['another', 'dispatched', 'real-two'],
    ['launched', 'failed', null],
    ['observed', 'failed', null]
  ]) {
    insert.run(
      id,
      state,
      handle,
      iso(-10000),
      state === 'dispatched' ? null : iso(-5000),
      iso(-10000)
    )
  }
  db.exec("INSERT INTO worker_dispatches VALUES ('launched', 'folder:project', 'real-failed')")
  const before = await readFile(join(directory, 'orchestration.db'))
  let store = new ActivityStore(NOW)
  store.agent('dispatch:ghost', { label: 'Source version worker' })
  store.point('dispatch:ghost:end', 'dispatch:ghost', NOW - 5000, 'done', 'orchestration')
  store.point('real-evidence', 'dispatch:observed', NOW - 6000, 'working', 'journal', NOW - 5500)
  const restore = () => {
    const restored = new ActivityStore(NOW)
    restored.restore(store.serialize(), NOW)
    store = restored
  }
  restore()
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  restore()
  const agents = store.snapshot(NOW).agents.filter((agent) => agent.taskId === 'task')
  assert.deepEqual(agents.map((agent) => agent.dispatchId).sort(), [
    'another',
    'launched',
    'observed',
    'retry'
  ])
  assert.equal(new Set(agents.map((agent) => agent.id)).size, 4)
  assert.equal(
    agents.find((agent) => agent.dispatchId === 'launched').terminalHandle,
    'real-failed'
  )
  assert.ok(
    agents
      .filter((agent) => agent.dispatchFailed)
      .every((agent) => agent.segments.every((segment) => segment.state !== 'done'))
  )
  assert.equal(store.points.get('dispatch:ghost:end').state, 'unknown')
  assert.deepEqual(await readFile(join(directory, 'orchestration.db')), before)
})

test('/new repairs cached run, spawn and message owners without moving old children or history', async (context) => {
  const { directory, db } = await fixture(context)
  const store = new ActivityStore(NOW)
  const old = status(store, 'old', -30000)
  store.agent(old, { runId: 'new-run' })
  store.aliases.set('run:new-run', old)
  const child = store.agent('child:old:native-child', { parentId: old })
  store.point('child-work', child, NOW - 20000, 'done', 'journal')
  store.point('old-work', old, NOW - 29000, 'working', 'live', NOW)
  store.point('misattributed-live', old, NOW - 10000, 'working', 'live', NOW - 9000)
  const successor = status(store, 'new', -10000)
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(
    'new-run',
    'New coordinator',
    'term:pane',
    'pane',
    null,
    iso(-9000)
  )
  db.prepare(`INSERT INTO dispatch_contexts
    (id, run_id, creator_handle, creator_pane_key, assignee_handle, dispatched_at, created_at)
    VALUES ('worker', 'new-run', 'term:pane', 'pane', 'worker-term', ?, ?)`).run(
    iso(-8000),
    iso(-8000)
  )
  store.agent('dispatch:worker', { parentId: old })
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
  for (const [id, from, to, offset] of [
    ['before', 'term:pane', 'worker-term', -20000],
    ['after', 'term:pane', 'dispatch:worker', -7000],
    ['reply', 'dispatch:worker', 'run:new-run', -6000],
    ['run-send', 'run:new-run', 'dispatch:worker', -5000]
  ]) {
    insert.run(id, from, to, from === 'term:pane' ? 'pane' : null, iso(offset), offset)
    store.message({ id: `message:${directory}:${id}`, from: old, to: old, at: NOW + offset })
  }
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  const reader = new OrcaLogReader(restored, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  await reader.scan(NOW)
  const message = (id) => restored.messages.get(`message:${directory}:${id}`)
  assert.equal(restored.aliases.get('run:new-run'), successor)
  assert.equal(restored.agents.get(old).runId, undefined)
  assert.equal(restored.agents.get('dispatch:worker').parentId, successor)
  assert.equal(restored.agents.get(child).parentId, old)
  assert.equal(message('before').from, old)
  assert.equal(message('after').from, successor)
  assert.equal(message('reply').to, successor)
  assert.equal(message('run-send').from, successor)
  assert.equal(restored.points.get('old-work').agentId, old)
  assert.equal(restored.points.get('old-work').until, NOW - 10000)
  assert.equal(restored.points.get('misattributed-live').agentId, successor)
  assert.equal(restored.agents.has(old), true)
  assert.equal(restored.agents.has(successor), true)
})

test('cold scan reads the successor transcript before routing orchestration created earlier than the latest status', async (context) => {
  const { directory, db } = await fixture(context)
  const path = join(directory, 'session.jsonl')
  await writeFile(
    path,
    `${JSON.stringify({
      timestamp: iso(-20000),
      type: 'event_msg',
      payload: { type: 'task_started' }
    })}\n`
  )
  await writeFile(
    join(directory, 'agent-hooks/last-status.json'),
    JSON.stringify({
      entries: {
        pane: {
          receivedAt: NOW - 1000,
          providerSession: { agent: 'codex', id: 'new', transcriptPath: path },
          payload: { state: 'working' }
        }
      }
    })
  )
  db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(
    'run',
    'Coordinator',
    'term:pane',
    'pane',
    null,
    iso(-10000)
  )
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(
    'msg',
    'term:pane',
    'run:run',
    'pane',
    iso(-9000),
    1
  )
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.equal(store.aliases.get('run:run'), 'native:codex:new')
  const message = store.messages.get(`message:${directory}:msg`)
  assert.equal(message.from, 'native:codex:new')
  assert.equal(message.to, 'native:codex:new')
})

test('routing honors durable sessions, keeps unknown history unresolved and can observe a resumed owner', () => {
  const store = new ActivityStore(NOW)
  const old = status(store, 'old', -30000)
  const successor = status(store, 'new', -10000)
  store.agent(old, { sessionId: 'durable' }, ['orca_session_id:durable'])
  status(store, 'old', -1000)
  const routing = new SessionRouting(store)
  const endpoint = { handle: 'term:pane', paneKey: 'pane' }
  assert.equal(routing.resolve(endpoint, NOW - 20000), old)
  assert.equal(routing.resolve(endpoint, NOW - 5000), successor)
  assert.equal(routing.resolve(endpoint, NOW), old)
  assert.equal(routing.resolve({ ...endpoint, sessionId: 'durable' }, NOW - 5000), old)
  const unknown = routing.resolve(endpoint, NOW - 40000)
  assert.notEqual(unknown, old)
  assert.notEqual(unknown, successor)
  assert.equal(store.aliases.get('pane:pane'), old)
})

test('native Chat live panes recover saved names and persisted harness identities after cache restore', async (context) => {
  const { directory } = await fixture(context)
  const journal = new DatabaseSync(join(directory, 'agent-session-journal.db'))
  context.after(() => journal.close())
  journal.exec(`CREATE TABLE agent_session_records (session_id TEXT, record_json TEXT);
    CREATE TABLE journal_rows (session_id TEXT, ts INTEGER, row_json TEXT);`)
  const store = new ActivityStore(NOW)
  const cases = [
    ['codex_chat', 'codex', { provider: 'codex', threadId: 'codex-thread' }],
    ['claude_chat', 'claude', { provider: 'claude', sessionId: 'claude-session', leafUuid: null }],
    ['grok_chat', 'grok', { transport: 'acp', agent: 'grok', nativeId: 'grok-session' }]
  ]
  for (const [sessionId, provider, handle] of cases) {
    const nativeId = handle.threadId ?? handle.sessionId ?? handle.nativeId
    const paneKey = `structured-agent-session-${sessionId}:leaf`
    const pane = store.agent(`pane:${paneKey}`, { paneKey, workspace: 'folder:shared' })
    store.point(`live:${sessionId}`, pane, NOW - 10000, 'working', 'live', NOW)
    store.agent(`native:${provider}:${nativeId}`, { provider, providerSessionId: nativeId })
    store.point(
      `history:${sessionId}`,
      `native:${provider}:${nativeId}`,
      NOW - 20000,
      'done',
      'journal'
    )
    store.message({ id: `message:${sessionId}`, from: pane, to: pane, at: NOW - 5000 })
    journal.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
      sessionId,
      JSON.stringify({
        provider,
        conversationName: `Named ${provider}`,
        conversationNameSource: 'user',
        location: { workspaceId: 'folder:shared' },
        providerHandleChain: [{ handle }]
      })
    )
  }
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  const reader = new OrcaLogReader(restored, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  await reader.scan(NOW)
  const snapshot = restored.snapshot(NOW)
  assert.equal(snapshot.agents.length, 3)
  for (const [sessionId, provider, handle] of cases) {
    const agent = snapshot.agents.find((item) => item.sessionId === sessionId)
    assert.equal(agent.label, `Named ${provider}`)
    assert.equal(agent.provider, provider)
    assert.equal(agent.providerSessionId, handle.threadId ?? handle.sessionId ?? handle.nativeId)
    assert.equal(restored.points.get(`live:${sessionId}`).agentId, agent.id)
    assert.equal(restored.points.get(`history:${sessionId}`).agentId, agent.id)
    assert.equal(restored.messages.get(`message:${sessionId}`).from, agent.id)
    assert.equal(bindStructuredPane(restored, agent.paneKey), agent.id)
  }
})

test('new Chat events bind exact sessions without merging unrelated chats or terminal panes', () => {
  const store = new ActivityStore(NOW)
  const first = bindStructuredPane(store, 'structured-agent-session-codex_first:leaf')
  const second = bindStructuredPane(store, 'structured-agent-session-codex_second:leaf')
  assert.notEqual(first, second)
  assert.equal(store.agents.get(first).sessionId, 'codex_first')
  assert.equal(bindStructuredPane(store, 'structured-agent-session-codex_first:other-leaf'), first)
  assert.equal(bindStructuredPane(store, 'terminal-tab:leaf'), undefined)
  assert.equal(bindStructuredPane(store, 'structured-agent-session-:leaf'), undefined)
  assert.equal(bindStructuredPane(store, undefined), undefined)
})

function dispatch(db, id = 'job', offset = -10000, extra = {}) {
  db.prepare(`INSERT INTO dispatch_contexts
    (id, run_id, task_id, status, creator_handle, assignee_handle, assignee_pane_key,
     assignee_orca_session_id, dispatched_at, completed_at, created_at)
    VALUES (?, 'run', ?, 'dispatched', 'parent', ?, ?, ?, ?, ?, ?)`).run(
    id,
    `task-${id}`,
    extra.handle ?? 'term:pane',
    extra.pane ?? 'pane',
    extra.sessionId ?? null,
    iso(offset),
    extra.end === undefined ? null : iso(extra.end),
    iso(offset)
  )
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run(`task-${id}`, `Task ${id}`)
  db.prepare('INSERT INTO worker_dispatches VALUES (?, ?, ?)').run(
    id,
    'folder:project',
    extra.handle ?? 'term:pane'
  )
}

function nativeWorker(store, id = 'worker', offset = -6000, extra = {}) {
  importStatusRow(
    store,
    extra.pane ?? 'pane',
    {
      receivedAt: NOW + offset,
      evidenceObservedAt: NOW - 500,
      connectionId: null,
      terminalHandle: extra.handle ?? 'term:pane',
      worktreeId: extra.workspace ?? 'folder:project',
      source: 'codex',
      providerSession: { key: 'session_id', id },
      payload: { agentType: 'codex', state: 'working' }
    },
    NOW
  )
  return `native:codex:${id}`
}

test('ready-only terminal placeholders are hidden before budgets without changing retained evidence', () => {
  const store = new ActivityStore(NOW)
  for (let i = 0; i < 200; i++) {
    const id = store.agent(`pane:ready-${i}`, {
      paneKey: `ready-${i}`,
      label: 'Codex ready',
      provider: 'codex'
    })
    store.point(`ready-${i}`, id, NOW - 20000, 'done', 'live', NOW - 10000)
  }
  for (const state of ['working', 'waiting', 'blocked', 'unknown']) {
    const id = store.agent(`pane:${state}`, { paneKey: state })
    store.point(state, id, NOW - 15000, state, 'live', NOW - 14000)
  }
  // A previously active unidentified agent and a real unknown dispatch must survive.
  store.point('previously-active', 'pane:ready-0', NOW - 30000, 'working', 'live', NOW - 25000)
  store.agent('pane:ready-1', { dispatchId: 'real-job', taskId: 'task' })
  store.point('assigned', 'pane:ready-1', NOW - 30000, 'unknown', 'orchestration')
  store.agent('child', { parentId: 'pane:ready-2', spawnedAt: NOW - 12000 })
  store.point('child', 'child', NOW - 12000, 'done', 'journal')
  store.message({ id: 'hidden-endpoint', from: 'pane:ready-2', to: 'child', at: NOW - 11000 })
  const before = store.serialize()
  const restored = new ActivityStore(NOW)
  restored.restore(before, NOW)
  for (const source of [store, restored]) {
    for (const hideShortTasks of [true, false]) {
      const snapshot = source.snapshot(NOW, { hideShortTasks })
      assert.equal(snapshot.agents.length, 7)
      assert.equal(snapshot.limited, false)
      assert.equal(snapshot.hiddenShortTasks, 0)
      assert.equal(snapshot.agents.find((agent) => agent.id === 'child').parentId, 'pane:ready-2')
      assert.deepEqual(snapshot.messages, [])
    }
  }
  assert.deepEqual(store.serialize(), before)
  nativeWorker(restored, 'enriched', -1000, { pane: 'ready-2' })
  assert.ok(restored.snapshot(NOW).agents.some((agent) => agent.providerSessionId === 'enriched'))
  assert.equal(restored.points.get('ready-2').agentId, 'native:codex:enriched')
})

test('dispatch placeholders reconcile with later native evidence across scans and cache restores', async (context) => {
  const { directory, db } = await fixture(context)
  dispatch(db)
  let store = new ActivityStore(NOW)
  let reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.equal(store.agents.get(store.aliases.get('dispatch:job')).providerSessionId, undefined)
  store.point('ready', store.aliases.get('dispatch:job'), NOW - 9000, 'done', 'live', NOW - 6000)
  store.agent('child', { parentId: store.aliases.get('dispatch:job') })
  store.point('child', 'child', NOW - 5000, 'done', 'journal')
  store.message({
    id: 'cached-message',
    from: 'parent',
    to: store.aliases.get('dispatch:job'),
    at: NOW - 8000
  })
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(
    'early-message',
    'parent',
    'term:pane',
    null,
    iso(-8000),
    1
  )
  const native = nativeWorker(store)
  // Restore the legacy duplicate rows before reconciliation, not just the fixed result.
  const duplicateCache = new ActivityStore(NOW)
  duplicateCache.restore(store.serialize(), NOW)
  reader.close()
  store = duplicateCache
  reader = new OrcaLogReader(store, [directory])
  await reader.scan(NOW)
  const reconciled = store.serialize()
  await reader.scan(NOW)
  assert.deepEqual(store.serialize(), reconciled)
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  reader.close()
  reader = new OrcaLogReader(restored, [directory])
  await reader.scan(NOW)
  await reader.scan(NOW)
  assert.equal(restored.aliases.get('dispatch:job'), native)
  assert.equal(restored.aliases.get('pane:pane'), native)
  assert.equal(restored.aliases.get('term:pane'), native)
  const worker = restored.agents.get(native)
  assert.equal(worker.label, 'Task job')
  assert.equal(worker.dispatchId, 'job')
  assert.equal(worker.runId, 'run')
  assert.equal(worker.taskId, 'task-job')
  assert.equal(worker.parentId, restored.aliases.get('parent'))
  assert.equal(worker.resumeTarget.providerSessionId, 'worker')
  assert.equal(restored.agents.get('child').parentId, native)
  assert.equal(restored.messages.get('cached-message').to, native)
  assert.equal(restored.messages.get(`message:${directory}:early-message`).to, native)
  assert.equal(restored.points.get('ready').agentId, native)
  assert.equal(restored.points.get('dispatch:job:start').agentId, native)
  assert.equal(restored.points.get('dispatch:job:start').state, 'unknown')
  assert.equal([...restored.agents.values()].filter((agent) => agent.paneKey === 'pane').length, 1)
  assert.ok(
    restored
      .snapshot(NOW)
      .agents.find((agent) => agent.id === native)
      .segments.some((segment) => segment.state === 'working')
  )
  const memory = new TerminalMemory(restored, [defaultDataDirectory()])
  assert.equal(memory.current(worker), true)
  memory.close()
})

test('cold dispatch reconciliation respects assignment time, ambiguity and endpoint reuse', async (context) => {
  for (const scenario of [
    'later',
    'prior',
    'expired',
    'ambiguous',
    'reuse',
    'conflicting-handle',
    'wrong-workspace'
  ]) {
    await context.test(scenario, async (t) => {
      const { directory, db } = await fixture(t)
      dispatch(db, 'job', -10000, scenario === 'expired' ? { end: -8000 } : {})
      const store = new ActivityStore(NOW)
      const native = nativeWorker(
        store,
        'worker',
        scenario === 'prior' ? -12000 : -6000,
        scenario === 'wrong-workspace' ? { workspace: 'folder:elsewhere' } : {}
      )
      if (scenario === 'ambiguous') nativeWorker(store, 'other', -6000)
      if (scenario === 'reuse') nativeWorker(store, 'old', -20000)
      if (scenario === 'conflicting-handle')
        nativeWorker(store, 'other', -6000, { pane: 'other-pane' })
      const reader = new OrcaLogReader(store, [directory])
      t.after(() => reader.close())
      await reader.scan(NOW)
      await reader.scan(NOW)
      const resolved = store.aliases.get('dispatch:job')
      assert.equal(resolved === native, ['later', 'prior'].includes(scenario))
      assert.equal(store.agents.get(native).providerSessionId, 'worker')
      if (!['later', 'prior'].includes(scenario)) {
        assert.equal(store.agents.get(resolved).providerSessionId, undefined)
        assert.equal(store.points.get('dispatch:job:start').state, 'unknown')
      }
    })
  }
})

test('followup dispatches share one durable conversation without self-parenting or stealing current pane ownership', async (context) => {
  const { directory, db } = await fixture(context)
  dispatch(db, 'first', -20000, { end: -11000 })
  dispatch(db, 'second', -10000)
  db.exec("UPDATE dispatch_contexts SET creator_handle = assignee_handle WHERE id = 'second'")
  const store = new ActivityStore(NOW)
  const native = nativeWorker(store, 'worker', -19000)
  nativeWorker(store, 'worker', -9000)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.equal(store.aliases.get('dispatch:first'), native)
  assert.equal(store.aliases.get('dispatch:second'), native)
  assert.equal(store.agents.get(native).dispatchId, 'second')
  assert.equal(store.agents.get(native).label, 'Task second')
  assert.notEqual(store.agents.get(native).parentId, native)
  const successor = nativeWorker(store, 'successor', -1000)
  await reader.scan(NOW)
  assert.equal(store.aliases.get('dispatch:first'), native)
  assert.equal(store.aliases.get('dispatch:second'), native)
  assert.equal(store.aliases.get('pane:pane'), successor)
  assert.equal(store.agents.get(native).providerSessionId, 'worker')
  assert.equal(store.agents.get(successor).providerSessionId, 'successor')
})

test('explicit native Chat dispatch identity overrides reused terminal addresses', async (context) => {
  const { directory, db } = await fixture(context)
  dispatch(db, 'chat-job', -10000, { sessionId: 'chat' })
  const store = new ActivityStore(NOW)
  const terminal = nativeWorker(store, 'terminal')
  const chat = bindStructuredPane(store, 'structured-agent-session-chat:leaf')
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.equal(store.aliases.get('dispatch:chat-job'), chat)
  assert.equal(store.agents.get(terminal).dispatchId, undefined)
  assert.equal(store.agents.get(chat).sessionId, 'chat')
})

test('a stale session cannot claim a launch while its new conversation has not appeared', async (context) => {
  const { directory, db } = await fixture(context)
  dispatch(db)
  const store = new ActivityStore(NOW)
  const old = status(store, 'old', -20000)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.notEqual(store.aliases.get('dispatch:job'), old)
  const successor = nativeWorker(store, 'successor')
  await reader.scan(NOW)
  assert.notEqual(store.aliases.get('dispatch:job'), old)
  assert.notEqual(store.aliases.get('dispatch:job'), successor)
  assert.equal(store.agents.get(old).providerSessionId, 'old')
  assert.equal(store.agents.get(successor).providerSessionId, 'successor')
  assert.equal(store.aliases.get('pane:pane'), successor)
})

test('a later assignment bounds enrichment so an unobserved earlier task cannot steal its session', async (context) => {
  const { directory, db } = await fixture(context)
  dispatch(db, 'first', -20000)
  dispatch(db, 'second', -10000)
  const store = new ActivityStore(NOW)
  const native = nativeWorker(store)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.notEqual(store.aliases.get('dispatch:first'), native)
  assert.equal(store.aliases.get('dispatch:second'), native)
  assert.equal(store.agents.get(native).taskId, 'task-second')
})
