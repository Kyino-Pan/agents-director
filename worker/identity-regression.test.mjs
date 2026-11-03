import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader, importStatusRow } from './orca-log-reader.mjs'
import { SessionRouting } from './session-routing.mjs'

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
