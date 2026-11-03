import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore, WINDOW_MS, timestamp } from './activity-store.mjs'
import {
  OrcaLogReader,
  importJournalRow,
  importStatusRow,
  defaultDataDirectory
} from './orca-log-reader.mjs'
import activate, { deactivate } from './main.mjs'
import { startPreview } from '../preview.mjs'
import { request } from 'node:http'

const NOW = Date.parse('2026-11-02T08:00:00Z')

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-activity-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const journal = new DatabaseSync(join(directory, 'agent-session-journal.db'))
  journal.exec(`CREATE TABLE journal_rows (session_id TEXT, epoch TEXT, seq INTEGER, ts INTEGER, row_json TEXT);
    CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT);`)
  const orchestration = new DatabaseSync(join(directory, 'orchestration.db'))
  orchestration.exec(`CREATE TABLE runs (id TEXT, objective TEXT, coordinator_handle TEXT,
    coordinator_pane_key TEXT, coordinator_orca_session_id TEXT, created_at TEXT);
    CREATE TABLE dispatch_contexts (id TEXT, run_id TEXT, creator_dispatch_id TEXT,
    assignee_handle TEXT, assignee_pane_key TEXT, assignee_orca_session_id TEXT,
    creator_handle TEXT, dispatched_at TEXT, completed_at TEXT, created_at TEXT);
    CREATE TABLE messages (id TEXT, from_handle TEXT, to_handle TEXT, type TEXT, subject TEXT,
    body TEXT, created_at TEXT, delivered_at TEXT, sequence INTEGER);`)
  await mkdir(join(directory, 'agent-hooks'))
  await writeFile(join(directory, 'agent-hooks', 'last-status.json'), '{"entries":{}}')
  context.after(() => {
    journal.close()
    orchestration.close()
  })
  return { directory, journal, orchestration }
}

test('clips at 7 days, preserves a crossing interval, expires old completed agents and messages', () => {
  const store = new ActivityStore(NOW)
  assert.equal(WINDOW_MS, 7 * 24 * 60 * 60 * 1000)
  const cutoff = NOW - WINDOW_MS
  store.point('cross', 'active', cutoff - 1000, 'working', 'journal', NOW - 1000)
  store.point('end', 'active', NOW - 1000, 'done', 'journal')
  store.point('expired', 'expired', cutoff - 1000, 'done', 'journal')
  store.message({ id: 'old', from: 'expired', to: 'active', at: cutoff - 1 })
  const snapshot = store.snapshot(NOW)
  assert.equal(snapshot.agents.length, 1)
  assert.deepEqual(snapshot.agents[0].segments[0], {
    start: cutoff,
    end: NOW - 1000,
    state: 'working',
    source: 'journal'
  })
  assert.equal(snapshot.messages.length, 0)
  assert.equal(store.agents.has('expired'), false)
})

test('offline time stays unknown after cache restore, rather than extending the last working state', () => {
  const store = new ActivityStore(NOW - 10000)
  store.point('work', 'agent', NOW - 10000, 'working', 'live', NOW - 5000)
  store.collectedUntil = NOW - 5000
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  assert.deepEqual(
    restored.snapshot(NOW).agents[0].segments.map((segment) => [segment.state, segment.end]),
    [
      ['working', NOW - 5000],
      ['unknown', NOW]
    ]
  )
})

test('overlapping same-state observations retain the longest evidence without bridging real gaps', () => {
  const store = new ActivityStore(NOW)
  store.point('status', 'agent', NOW - 10000, 'working', 'status-cache', NOW - 1000)
  store.point('transcript', 'agent', NOW - 9971, 'working', 'transcript', NOW - 9971)
  let segments = store.snapshot(NOW).agents[0].segments
  assert.deepEqual(
    segments.map(({ state, start, end }) => [state, start, end]),
    [
      ['working', NOW - 10000, NOW - 1000],
      ['unknown', NOW - 1000, NOW]
    ]
  )
  assert.equal(segments[0].source, 'status-cache')
  store.point('later', 'agent', NOW - 500, 'working', 'status-cache', NOW)
  segments = store.snapshot(NOW).agents[0].segments
  assert.deepEqual(
    segments.map(({ state, start, end }) => [state, start, end]),
    [
      ['working', NOW - 10000, NOW - 1000],
      ['unknown', NOW - 1000, NOW - 500],
      ['working', NOW - 500, NOW]
    ]
  )
})

test('imports and restores history older than 24h while excluding records beyond 7 days', async (context) => {
  const { directory, journal, orchestration } = await fixture(context)
  const day = 24 * 60 * 60 * 1000
  const at = NOW - 3 * day
  const row = {
    kind: 'item',
    epoch: 'e',
    itemId: 'older-turn',
    ts: at,
    body: { kind: 'turn', state: 'completed', startedAt: at - 5000, completedAt: at }
  }
  journal
    .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
    .run('older-session', 'e', 1, at, JSON.stringify(row))
  const insert = orchestration.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const [id, days] of [
    ['inside', 6],
    ['outside', 8]
  ]) {
    insert.run(
      id,
      'sender',
      'recipient',
      'status',
      'History',
      '',
      new Date(NOW - days * day).toISOString(),
      null,
      1
    )
  }
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  const snapshot = restored.snapshot(NOW)
  assert.equal(snapshot.windowStart, NOW - 7 * day)
  assert.ok(
    snapshot.agents
      .find((agent) => agent.sessionId === 'older-session')
      ?.segments.some((segment) => segment.start === at - 5000)
  )
  assert.deepEqual(
    snapshot.messages.map((message) => message.id),
    [`message:${directory}:inside`]
  )
})

test('new conversation in the same pane remains separate from its previous session', () => {
  const store = new ActivityStore(NOW)
  const row = (id, at) => ({
    receivedAt: at,
    providerSession: { agent: 'codex', id },
    payload: { state: 'working' }
  })
  importStatusRow(store, 'same-pane', row('one', NOW - 2000), NOW)
  importStatusRow(store, 'same-pane', row('two', NOW - 1000), NOW)
  assert.equal(store.agents.size, 2)
  assert.equal(store.aliases.get('pane:same-pane'), 'native:codex:two')
})

test('revised journal turns reconstruct durations, prompts and nested child branches', () => {
  const store = new ActivityStore(NOW)
  const row = {
    kind: 'item',
    epoch: 'epoch',
    itemId: 'turn',
    ts: NOW - 1000,
    body: { kind: 'turn', state: 'running', startedAt: NOW - 10000 }
  }
  importJournalRow(store, 'parent', row, NOW)
  importJournalRow(
    store,
    'parent',
    {
      ...row,
      ts: NOW,
      body: {
        ...row.body,
        state: 'completed',
        completedAt: NOW - 500
      }
    },
    NOW
  )
  importJournalRow(
    store,
    'parent',
    {
      ...row,
      itemId: 'children',
      body: {
        kind: 'message',
        blocks: [
          {
            type: 'subagent',
            id: 'child',
            label: 'Reviewer',
            state: 'completed',
            startedAt: NOW - 9000,
            settledAt: NOW - 800
          },
          {
            type: 'subagent',
            id: 'grandchild',
            parentId: 'child',
            label: 'Audit',
            state: 'working',
            startedAt: NOW - 5000
          }
        ]
      }
    },
    NOW
  )
  const snapshot = store.snapshot(NOW)
  const parent = snapshot.agents.find((agent) => agent.id === 'session:parent')
  assert.equal(parent.segments[0].start, NOW - 10000)
  assert.equal(parent.segments[0].end, NOW - 500)
  const child = snapshot.agents.find((agent) => agent.label === 'Reviewer')
  assert.equal(child.parentId, parent.id)
  assert.equal(snapshot.agents.find((agent) => agent.label === 'Audit').parentId, child.id)
  assert.equal(child.segments.at(-1).state, 'done')
  assert.equal(child.segments[0].state, 'working')
  assert.equal(store.points.size, 5)
})

test('reads actual SQLite logs, correlates addresses, deduplicates polls and sees appended/revised messages', async (context) => {
  const { directory, journal, orchestration } = await fixture(context)
  journal.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
    'parent-session',
    JSON.stringify({
      provider: 'codex',
      conversationName: 'Coordinator',
      location: { workspaceId: 'folder:project' },
      providerHandleChain: [{ handle: { agent: 'codex', nativeId: 'provider-session' } }]
    })
  )
  const row = {
    kind: 'item',
    epoch: 'e',
    itemId: 't',
    ts: NOW - 1000,
    body: { kind: 'turn', state: 'completed', startedAt: NOW - 5000, completedAt: NOW - 1000 }
  }
  journal
    .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
    .run('parent-session', 'e', 1, row.ts, JSON.stringify(row))
  orchestration
    .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)')
    .run('r', 'Coordinate', 'coordinator-handle', 'p:1', 'parent-session', '2026-11-02 07:00:00')
  orchestration
    .prepare('INSERT INTO dispatch_contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'd',
      'r',
      null,
      'worker-handle',
      'p:2',
      null,
      'coordinator-handle',
      '2026-11-02 07:10:00',
      null,
      '2026-11-02 07:10:00'
    )
  orchestration
    .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'm',
      'coordinator-handle',
      'dispatch:d',
      'dispatch',
      'Review',
      'Review the change',
      '2026-11-02 07:11:00',
      null,
      1
    )
  const original = await readFile(join(directory, 'orchestration.db'))
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  await reader.scan(NOW)
  const snapshot = store.snapshot(NOW)
  assert.equal(snapshot.messages.length, 1)
  assert.equal(snapshot.messages[0].from, store.aliases.get('orca_session_id:parent-session'))
  assert.equal(snapshot.messages[0].to, store.aliases.get('dispatch:d'))
  const worker = snapshot.agents.find((agent) => agent.id === snapshot.messages[0].to)
  assert.equal(worker.parentId, snapshot.messages[0].from)
  assert.equal(worker.segments[0].state, 'unknown')
  assert.deepEqual(
    snapshot.sources.map((source) => source.status),
    ['missing', 'ok', 'ok', 'ok']
  )
  assert.deepEqual(await readFile(join(directory, 'orchestration.db')), original)
  orchestration
    .prepare('UPDATE messages SET delivered_at = ? WHERE id = ?')
    .run('2026-11-02 07:12:00', 'm')
  await reader.scan(NOW)
  assert.equal(store.snapshot(NOW).messages[0].deliveredAt, Date.parse('2026-11-02T07:12:00Z'))
  assert.throws(
    () => reader.database(join(directory, 'orchestration.db')).exec('DELETE FROM messages'),
    /readonly|read-only/
  )
})

test('human names survive correlation and polling while full navigation identities remain available', async (context) => {
  const { directory, journal, orchestration } = await fixture(context)
  journal.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
    'named-session',
    JSON.stringify({
      provider: 'codex',
      conversationName: 'My coordinator',
      conversationNameSource: 'user',
      providerHandleChain: [{ handle: { agent: 'codex', nativeId: 'native-parent' } }]
    })
  )
  orchestration.exec(`ALTER TABLE dispatch_contexts ADD COLUMN task_id TEXT;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, display_name TEXT, task_title TEXT);
    INSERT INTO tasks VALUES ('named-task', 'Astra · Activity design', 'Activity UI');`)
  orchestration
    .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      'named-run',
      'A different objective',
      'parent-handle',
      'parent-pane',
      'named-session',
      '2026-11-02 07:00:00'
    )
  orchestration
    .prepare(`INSERT INTO dispatch_contexts
    (id, run_id, task_id, creator_handle, assignee_handle, assignee_pane_key, dispatched_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'named-dispatch',
      'named-run',
      'named-task',
      'parent-handle',
      'child-handle',
      'child-pane',
      '2026-11-02 07:10:00',
      '2026-11-02 07:10:00'
    )
  await writeFile(
    join(directory, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      entries: {
        'parent-pane': {
          receivedAt: NOW,
          providerSession: { agent: 'codex', id: 'native-parent' },
          payload: { state: 'working', terminalTitle: 'Codex' }
        },
        'child-pane': {
          receivedAt: NOW,
          terminalHandle: 'child-handle',
          providerSession: { agent: 'codex', id: 'native-child' },
          payload: { state: 'working', orchestration: { dispatchId: 'named-dispatch' } }
        }
      }
    })
  )
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  await reader.scan(NOW)
  let snapshot = store.snapshot(NOW)
  const parent = snapshot.agents.find((agent) => agent.sessionId === 'named-session')
  assert.equal(parent.label, 'My coordinator')
  assert.equal(parent.labelSource, 'user')
  assert.equal(parent.providerSessionId, 'native-parent')
  const child = snapshot.agents.find((agent) => agent.dispatchId === 'named-dispatch')
  assert.equal(child.label, 'Astra · Activity design')
  assert.equal(child.providerSessionId, 'native-child')
  assert.equal(child.terminalHandle, 'child-handle')
  assert.equal(child.paneKey, 'child-pane')
  assert.equal(child.taskId, 'named-task')
  assert.equal(child.runId, 'named-run')
  assert.equal(child.parentId, parent.id)
  const canonicalId = child.id
  orchestration
    .prepare('UPDATE tasks SET display_name = ? WHERE id = ?')
    .run('Astra · Color review', 'named-task')
  await reader.scan(NOW)
  snapshot = store.snapshot(NOW)
  assert.equal(
    snapshot.agents.find((agent) => agent.id === canonicalId).label,
    'Astra · Color review'
  )
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  assert.equal(restored.agents.get(canonicalId).providerSessionId, 'native-child')
})

test('tails only Orca-referenced logs, waits for complete UTF-8 records, and handles truncation', async (context) => {
  const { directory } = await fixture(context)
  const path = join(directory, 'session.jsonl')
  const start = JSON.stringify({
    timestamp: new Date(NOW - 10000).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_started', text: '开始' }
  })
  const encoded = Buffer.from(`${start}\n`)
  const split = encoded.indexOf(Buffer.from('始')) + 1
  await writeFile(path, encoded.subarray(0, split))
  await writeFile(
    join(directory, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      entries: {
        pane: {
          receivedAt: NOW - 10000,
          providerSession: { agent: 'codex', id: 'id', transcriptPath: path },
          payload: { state: 'working' }
        }
      }
    })
  )
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.equal(
    [...store.points.values()].some((point) => point.source === 'transcript'),
    false
  )
  await appendFile(path, encoded.subarray(split))
  const done = JSON.stringify({
    timestamp: new Date(NOW - 1000).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_complete' }
  })
  await appendFile(path, `${done}\n`)
  await reader.scan(NOW)
  const points = [...store.points.values()].filter((point) => point.source === 'transcript')
  assert.equal(points.length, 2)
  assert.equal(points.find((point) => point.state === 'working').until, NOW - 1000)
  await writeFile(path, `${done}\n`)
  await reader.scan(NOW)
  assert.equal(
    [...store.points.values()].filter((point) => point.source === 'transcript').length,
    2
  )
})

test('collector records live changes, persists on shutdown, and restores history on restart', async (context) => {
  const { directory } = await fixture(context)
  const storage = new Map()
  const handlers = new Map()
  let listener
  let disposed = 0
  const api = {
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => storage.set(key, value),
      delete: async (key) => storage.delete(key)
    },
    settings: { get: async () => directory },
    panels: { handle: (name, handler) => handlers.set(name, handler), post: () => {} },
    commands: { register: () => {} },
    events: {
      on: (_, handler) => {
        listener = handler
        return { dispose: () => disposed++ }
      }
    }
  }
  context.after(() => deactivate())
  await activate(api)
  const at = Date.now() - 1000
  listener({ paneKey: 'live-pane', title: 'Live agent', state: 'working', receivedAt: at })
  listener({ paneKey: 'live-pane', title: 'Live agent', state: 'done', receivedAt: at + 500 })
  let snapshot = await handlers.get('activity.snapshot')()
  assert.deepEqual(
    snapshot.agents
      .find((agent) => agent.label === 'Live agent')
      .segments.map((segment) => segment.state),
    ['working', 'done']
  )
  await deactivate()
  assert.equal(disposed, 1)
  assert.equal(storage.get('activity-v1:head').version, 1)
  await activate(api)
  snapshot = await handlers.get('activity.snapshot')()
  assert.equal(
    snapshot.agents.some((agent) => agent.label === 'Live agent'),
    true
  )
})

test('reports missing and unsupported sources instead of claiming an empty complete history', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-activity-missing-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  assert.equal(
    store.snapshot(NOW).sources.filter((source) => source.status === 'missing').length,
    4
  )
  assert.equal(timestamp('2026-11-02 08:00:00'), NOW)
  assert.equal(
    defaultDataDirectory('darwin', '/home/test'),
    join('/home/test', 'Library', 'Application Support', 'orca')
  )
})

test('loopback preview serves the actual collector and rejects other paths, origins and mutations', async (context) => {
  const { directory, orchestration } = await fixture(context)
  const created = new Date().toISOString().replace('T', ' ').slice(0, 19)
  orchestration
    .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'preview-message',
      'sender',
      'recipient',
      'status',
      'Preview',
      'From a real SQLite row',
      created,
      null,
      1
    )
  const preview = await startPreview({ directories: [directory] })
  context.after(() => preview.close())
  const response = await fetch(`${preview.url}snapshot`)
  const snapshot = await response.json()
  assert.equal(snapshot.messages[0].body, 'From a real SQLite row')
  assert.equal(
    snapshot.sources.some((source) => source.name === 'Preview mode'),
    true
  )
  const html = await (await fetch(preview.url)).text()
  assert.match(html, /bridge.mjs/)
  assert.match(html, /--orca-background:/)
  assert.match(html, /--orca-destructive:/)
  assert.equal((await fetch(new URL('/snapshot', preview.url))).status, 404)
  assert.equal((await fetch(`${preview.url}snapshot`, { method: 'POST' })).status, 404)
  const foreignHost = await new Promise((resolve, reject) => {
    const connection = request(
      `${preview.url}snapshot`,
      { headers: { host: 'evil.example' } },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    connection.on('error', reject)
    connection.end()
  })
  assert.equal(foreignHost, 404)
})

test('historical orchestration pane bindings never merge a successor conversation', () => {
  const store = new ActivityStore(NOW)
  const row = (id) => ({
    receivedAt: NOW - 1000,
    providerSession: { agent: 'codex', id },
    payload: { state: 'working' }
  })
  importStatusRow(store, 'pane', row('old'), NOW)
  store.agent('run:old', {}, ['old-handle', 'pane:pane', 'native:codex:old'])
  importStatusRow(store, 'pane', row('new'), NOW)
  store.agent('run:old', {}, ['old-handle', 'pane:pane', 'native:codex:old'])
  assert.equal(store.agents.size, 2)
  assert.notEqual(store.aliases.get('native:codex:old'), store.aliases.get('native:codex:new'))
  assert.equal(store.aliases.get('pane:pane'), store.aliases.get('native:codex:new'))
})

test('Codex child completion preserves its work and unifies cache and transcript identities', async () => {
  const { importTranscriptRow } = await import('./orca-log-reader.mjs')
  const store = new ActivityStore(NOW)
  importStatusRow(
    store,
    'pane',
    {
      receivedAt: NOW - 1000,
      providerSession: { agent: 'codex', id: 'root' },
      payload: {
        state: 'working',
        subagents: [{ id: 'child-thread', state: 'working', startedAt: NOW - 5000 }]
      }
    },
    NOW
  )
  const parent = store.aliases.get('native:codex:root')
  const child = (kind, at) => ({
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      agent_thread_id: 'child-thread',
      kind,
      occurred_at_ms: at
    }
  })
  importTranscriptRow(store, parent, 'codex', child('started', NOW - 5000), 'file')
  importTranscriptRow(store, parent, 'codex', child('completed', NOW - 500), 'file')
  const snapshot = store.snapshot(NOW)
  assert.equal(snapshot.agents.length, 2)
  const lane = snapshot.agents.find((agent) => agent.parentId === parent)
  assert.equal(lane.spawnedAt, NOW - 5000)
  assert.equal(lane.segments.at(-1).state, 'done')
  assert.equal(
    lane.segments
      .filter((segment) => segment.state === 'working')
      .reduce((sum, segment) => sum + segment.end - segment.start, 0),
    4500
  )
})
