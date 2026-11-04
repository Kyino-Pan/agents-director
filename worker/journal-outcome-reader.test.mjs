import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader } from './orca-log-reader.mjs'
import activate, { deactivate } from './main.mjs'

const NOW = Date.now()
const turn = (id, end = NOW - 1000) => ({
  itemId: id,
  revision: 1,
  sequence: 1,
  observedAt: NOW - 5000,
  body: {
    kind: 'turn',
    startedAt: NOW - 10000,
    completedAt: end,
    state: end ? 'completed' : 'running'
  }
})

async function fixture(context, prefix = []) {
  const directory = await mkdtemp(join(tmpdir(), 'activity-outcomes-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'agent-session-journal.db')
  const db = new DatabaseSync(path)
  context.after(() => db.close())
  db.exec(`CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT);
    CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT);
    CREATE TABLE journal_rows (session_id TEXT, epoch TEXT, seq INTEGER, ts INTEGER, row_json TEXT,
      PRIMARY KEY (session_id, epoch, seq));
    CREATE TABLE journal_outcome_epochs (session_id TEXT PRIMARY KEY, epoch TEXT, generation INTEGER,
      format INTEGER, through_seq INTEGER, prefix_seq INTEGER);
    CREATE TABLE journal_outcomes (generation INTEGER, seq INTEGER, field TEXT, entry_key TEXT,
      format INTEGER, ordinal TEXT, value_json TEXT, deleted INTEGER,
      PRIMARY KEY (generation, seq, field, entry_key));
    CREATE INDEX journal_outcome_keys ON journal_outcomes (generation, field, entry_key, seq DESC);
    INSERT INTO journal_sessions VALUES ('chat', 'epoch');`)
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
    'chat',
    JSON.stringify({
      conversationName: 'Named Codex Chat',
      provider: 'codex',
      providerHandleChain: [{ handle: { provider: 'codex', threadId: 'native-thread' } }]
    })
  )
  const row = db.prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
  for (const [index, value] of prefix.entries()) {
    row.run(
      'chat',
      'epoch',
      index + 1,
      NOW - 5000,
      JSON.stringify({ v: 4, epoch: 'epoch', seq: index + 1, ts: NOW - 5000, ...value })
    )
  }
  row.run(
    'chat',
    'epoch',
    prefix.length + 1,
    NOW - 5000,
    JSON.stringify({
      v: 5,
      kind: 'outcomes',
      epoch: 'epoch',
      seq: prefix.length + 1,
      ts: NOW - 5000
    })
  )
  db.prepare('INSERT INTO journal_outcome_epochs VALUES (?, ?, ?, ?, ?, ?)').run(
    'chat',
    'epoch',
    1,
    2,
    prefix.length,
    prefix.length
  )
  const write = (seq, item, { generation = 1, key = item?.itemId, format = 2 } = {}) => {
    db.prepare('INSERT INTO journal_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      generation,
      seq,
      'items',
      JSON.stringify(key),
      format,
      String(seq),
      JSON.stringify(item),
      item === null ? 1 : 0
    )
    db.prepare(
      'UPDATE journal_outcome_epochs SET through_seq = MAX(through_seq, ?) WHERE generation = ?'
    ).run(seq, generation)
  }
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  return { directory, path, db, write, store, reader }
}

test('first activation restores named native Chat history; current host events join that lane', async (context) => {
  const { directory, path, write } = await fixture(context)
  write(1, turn('completed'), { format: 1 })
  write(2, turn('open', null))
  const before = await readFile(path)
  const handlers = new Map()
  const cache = new Map()
  let listener
  const api = {
    storage: {
      get: async (key) => cache.get(key),
      set: async (key, value) => cache.set(key, value),
      delete: async (key) => cache.delete(key)
    },
    settings: { get: async () => directory },
    panels: { handle: (key, value) => handlers.set(key, value), post: () => {} },
    commands: { register: () => {} },
    events: {
      on: (_, callback) => {
        listener = callback
        return { dispose: () => {} }
      }
    }
  }
  context.after(() => deactivate())
  await activate(api)
  let snapshot = await handlers.get('activity.snapshot')()
  assert.equal(snapshot.agents.length, 1)
  assert.equal(snapshot.agents[0].label, 'Named Codex Chat')
  assert.equal(snapshot.agents[0].providerSessionId, 'native-thread')
  assert.ok(snapshot.agents[0].segments.some((segment) => segment.state === 'working'))
  listener({
    worktreeId: 'folder:project',
    paneKey: 'structured-agent-session-chat:pane',
    state: 'working',
    receivedAt: NOW
  })
  snapshot = await handlers.get('activity.snapshot')()
  assert.equal(snapshot.agents.length, 1)
  assert.equal(snapshot.agents[0].workspace, 'folder:project')
  assert.equal(snapshot.agents[0].label, 'Named Codex Chat')
  await deactivate()
  await activate(api)
  snapshot = await handlers.get('activity.snapshot')()
  assert.equal(snapshot.agents.length, 1)
  assert.deepEqual(await readFile(path), before)
})

test('open outcomes never bridge unobserved time, including unchanged scans and cache restart', async (context) => {
  const { write, store, reader, directory } = await fixture(context)
  write(1, turn('open', null))
  await reader.scan(NOW)
  const states = (value) =>
    value.snapshot(NOW).agents[0].segments.map(({ state, end }) => [state, end])
  assert.deepEqual(states(store), [
    ['working', NOW - 5000],
    ['unknown', NOW]
  ])
  await reader.scan(NOW)
  assert.deepEqual(states(store), [
    ['working', NOW - 5000],
    ['unknown', NOW]
  ])
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  const restarted = new OrcaLogReader(restored, [directory])
  context.after(() => restarted.close())
  await restarted.scan(NOW)
  assert.deepEqual(states(restored), [
    ['working', NOW - 5000],
    ['unknown', NOW]
  ])
})

test('latest values replace revisions, delete prefix items, and exclude inactive generations and unpublished writes', async (context) => {
  const prefix = ['kept', 'deleted'].map((id) => ({ kind: 'item', ...turn(id) }))
  const { write, store, reader, db, directory } = await fixture(context, prefix)
  write(3, null, { key: 'deleted' })
  write(4, turn('updated'))
  write(5, turn('updated', null))
  write(6, turn('unpublished'))
  db.exec('UPDATE journal_outcome_epochs SET through_seq = 5')
  write(1, turn('inactive'), { generation: 99 })
  await reader.scan(NOW)
  const ids = () => [...store.points.keys()]
  assert.ok(ids().some((id) => id.includes(':kept:')))
  assert.ok(!ids().some((id) => /deleted|inactive|unpublished/.test(id)))
  assert.ok(!ids().includes('journal:chat:epoch:updated:end'))
  write(7, turn('updated', NOW - 500))
  write(8, null, { key: 'kept' })
  await reader.scan(NOW)
  assert.equal(store.points.get('journal:chat:epoch:updated:end').at, NOW - 500)
  assert.ok(!ids().some((id) => id.includes(':kept:')))
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  db.exec('UPDATE journal_outcome_epochs SET generation = 2, through_seq = 3')
  write(3, null, { generation: 2, key: 'deleted' })
  const restarted = new OrcaLogReader(restored, [directory])
  context.after(() => restarted.close())
  await restarted.scan(NOW)
  assert.deepEqual([...restored.points.keys()].sort(), [
    'journal:chat:epoch:kept:end',
    'journal:chat:epoch:kept:start'
  ])
  await reader.scan(NOW)
  assert.deepEqual(ids().sort(), [...restored.points.keys()].sort())
})

test('large outcome sets catch up in bounded passes and unchanged scans do not reread item values', async (context) => {
  const { write, store, reader, path } = await fixture(context)
  for (let index = 0; index < 2001; index++) {
    write(index + 1, { ...turn(`message-${index}`), body: { kind: 'message', blocks: [] } })
  }
  write(2002, turn('z-turn'))
  await reader.scan(NOW)
  assert.equal(store.sources.get(path).status, 'limited')
  await reader.scan(NOW)
  assert.equal(store.sources.get(path).status, 'ok')
  assert.equal(store.snapshot(NOW).agents.length, 1)
  const db = reader.database(path)
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    assert.ok(!sql.includes('value_json'), 'unchanged scan must not read outcome values')
    return prepare(sql)
  }
  await reader.scan(NOW)
  assert.equal(store.sources.get(path).status, 'ok')
})

test('unsupported outcome formats remain visible in coverage across scans', async (context) => {
  const { write, store, reader, db, path } = await fixture(context)
  write(1, turn('newer'))
  db.exec('UPDATE journal_outcome_epochs SET format = 99')
  for (let index = 0; index < 2; index++) {
    await reader.scan(NOW)
    assert.equal(store.sources.get(path).status, 'limited')
    assert.match(store.sources.get(path).detail, /Unsupported journal outcome format 99/)
    assert.equal(store.snapshot(NOW).agents.length, 0)
  }
})

test('outcome deletions also remove child evidence and completed prompts retain their wait interval', async (context) => {
  const { write, store, reader } = await fixture(context)
  write(1, {
    ...turn('children'),
    body: {
      kind: 'message',
      blocks: [{ type: 'subagent', id: 'child', state: 'running', startedAt: NOW - 8000 }]
    }
  })
  write(2, {
    ...turn('approval'),
    body: { kind: 'approval', resolution: { state: 'resolved', resolvedAt: NOW - 1000 } }
  })
  await reader.scan(NOW)
  assert.equal(store.snapshot(NOW).agents.length, 2)
  const waiting = store
    .snapshot(NOW)
    .agents.find((agent) => agent.sessionId === 'chat')
    .segments.find((segment) => segment.state === 'waiting')
  assert.equal(waiting.end, NOW - 1000)
  write(3, null, { key: 'children' })
  await reader.scan(NOW)
  assert.equal(store.snapshot(NOW).agents.length, 1)
})

test('outcome markers without their source tables do not become healthy on the next scan', async (context) => {
  const { db, store, reader, path } = await fixture(context)
  db.exec('DROP TABLE journal_outcome_epochs; DROP TABLE journal_outcomes')
  for (let index = 0; index < 2; index++) {
    await reader.scan(NOW)
    assert.equal(store.sources.get(path).status, 'limited')
    assert.match(store.sources.get(path).detail, /missing outcome source/)
  }
})
