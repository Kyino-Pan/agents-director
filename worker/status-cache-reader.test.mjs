import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader } from './orca-log-reader.mjs'

const NOW = Date.parse('2026-11-16T02:00:00Z')

async function fixture(t, version = '202') {
  const directory = await mkdtemp(join(tmpdir(), 'director-status-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'agent-hooks'))
  const path = join(directory, 'agent-hooks', 'last-status.db')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE rows(key TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);`)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', version)
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  t.after(() => {
    reader.close()
    db.close()
  })
  const put = (pane, value, seq = 1) =>
    db
      .prepare('INSERT OR REPLACE INTO rows VALUES (?, ?, ?)')
      .run(`entry\0${pane}`, seq, JSON.stringify(value))
  const row = (pane, native = 'conversation') => ({
    paneKey: pane,
    worktreeId: 'repo::/project',
    connectionId: null,
    receivedAt: NOW - 1000,
    stateStartedAt: NOW - 5000,
    providerSession: { key: 'session_id', id: native },
    payload: { agentType: 'codex', state: 'working' }
  })
  return { directory, path, db, store, reader, put, row }
}

test('SQLite WAL status restores pane identity, resume target and transcript activity', async (t) => {
  const { directory, path, store, reader, put, row } = await fixture(t)
  const transcript = join(directory, 'transcript.jsonl')
  await writeFile(
    transcript,
    JSON.stringify({
      timestamp: new Date(NOW - 500).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete' }
    }) + '\n'
  )
  const value = row('tab:leaf')
  value.providerSession.transcriptPath = transcript
  put('tab:leaf', value)
  put('other:leaf', row('other:leaf', 'other'), 2)
  // A pane-only live observation must merge into the durable provider identity.
  store.agent('pane:tab:leaf', { paneKey: 'tab:leaf' })
  store.point('live', 'pane:tab:leaf', NOW - 5000, 'working', 'live', NOW - 1000)
  await reader.scan(NOW)
  const agent = store.agents.get('native:codex:conversation')
  assert.equal(store.agents.has('pane:tab:leaf'), false)
  assert.equal(store.aliases.get('pane:tab:leaf'), agent.id)
  assert.equal(store.aliases.get('pane:other:leaf'), 'native:codex:other')
  assert.deepEqual(agent.resumeTarget, {
    kind: 'terminal',
    provider: 'codex',
    providerSessionId: 'conversation',
    providerSessionKey: 'session_id',
    transcriptPath: transcript,
    workspace: 'repo::/project',
    executionHostId: 'local',
    wslDistro: null
  })
  assert.equal(store.sources.get(path).status, 'ok')
  const lane = store.snapshot(NOW).agents.find((a) => a.id === agent.id)
  assert.ok(lane.segments.some((s) => s.state === 'done' && s.start === NOW - 500))
})

test('SQLite cache takes precedence over a leftover legacy JSON file', async (t) => {
  const { directory, store, reader, put, row } = await fixture(t)
  put('new:leaf', row('new:leaf', 'new'))
  await writeFile(
    join(directory, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      entries: { 'old:leaf': row('old:leaf', 'stale') }
    })
  )
  await reader.scan(NOW)
  assert.ok(store.agents.has('native:codex:new'))
  assert.equal(store.agents.has('native:codex:stale'), false)
})

test('unknown status schemas report an error without importing stale JSON', async (t) => {
  const { directory, path, store, reader, put, row } = await fixture(t, '999')
  put('tab:leaf', row('tab:leaf'))
  await writeFile(
    join(directory, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      entries: { 'tab:leaf': row('tab:leaf') }
    })
  )
  await reader.scan(NOW)
  assert.equal(store.agents.size, 0)
  assert.equal(store.sources.get(path).status, 'error')
  assert.match(store.sources.get(path).detail, /Unsupported/)
})

test('invalid pane ownership rejects the entire status snapshot', async (t) => {
  const { path, store, reader, put, row } = await fixture(t)
  put('valid:leaf', row('valid:leaf'))
  put('wrong:leaf', row('another:leaf'), 2)
  await reader.scan(NOW)
  assert.equal(store.agents.size, 0)
  assert.match(store.sources.get(path).detail, /pane identity/)
})

test('oversized SQLite status payloads stay outside collector memory', async (t) => {
  const { path, db, store, reader } = await fixture(t)
  db.prepare('INSERT INTO rows VALUES (?, ?, ?)').run(
    'entry\0large',
    1,
    'x'.repeat(32 * 1024 * 1024 + 1)
  )
  await reader.scan(NOW)
  assert.equal(store.agents.size, 0)
  assert.match(store.sources.get(path).detail, /bounded reader limit/)
})

test(
  'an unreadable database reports its own failure and other directories still collect',
  { skip: process.platform === 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'director-status-isolation-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const bad = join(directory, 'bad')
    const good = join(directory, 'good')
    for (const dir of [bad, good]) await mkdir(join(dir, 'agent-hooks'), { recursive: true })
    const path = join(bad, 'agent-hooks', 'last-status.db')
    await symlink(path, path)
    const row = (id) => ({
      receivedAt: NOW - 1000,
      providerSession: { agent: 'codex', id },
      payload: { state: 'working' }
    })
    for (const [dir, id] of [
      [bad, 'stale'],
      [good, 'healthy']
    ]) {
      await writeFile(
        join(dir, 'agent-hooks', 'last-status.json'),
        JSON.stringify({
          entries: { [id]: row(id) }
        })
      )
    }
    const store = new ActivityStore(NOW)
    const reader = new OrcaLogReader(store, [bad, good])
    t.after(() => reader.close())
    await reader.scan(NOW)
    assert.equal(store.sources.get(path).status, 'error')
    assert.equal(store.agents.has('native:codex:stale'), false)
    assert.equal(store.agents.has('native:codex:healthy'), true)
  }
)
