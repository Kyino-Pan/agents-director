import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RecentInputs, transcriptInputs, journalInputs, TEXT_LIMIT } from './recent-inputs.mjs'
import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader, importStatusRow } from './orca-log-reader.mjs'

const now = Date.now()
const iso = (n) => new Date(now + n).toISOString()
async function fixture(t, provider, rows) {
  const root = await mkdtemp(join(tmpdir(), 'director-inputs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'session.jsonl')
  await writeFile(path, rows.map(JSON.stringify).join('\n') + '\n')
  const entry = {
    path,
    directory: root,
    provider,
    providerSessionId: 'one',
    id: `native:${provider}:one`
  }
  return { root, path, entry, read: () => transcriptInputs(entry, [root]) }
}
const event = (n, message) => ({
  timestamp: iso(n),
  type: 'event_msg',
  payload: { type: 'user_message', message }
})
const response = (n, text) => ({
  timestamp: iso(n),
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }]
  }
})
const claude = (n, text, uuid = `u${n}`) => ({
  type: 'user',
  sessionId: 'one',
  uuid,
  timestamp: iso(n),
  message: { role: 'user', content: text }
})

test('legacy Codex chooses user events over model copies and preserves identical distinct turns', async (t) => {
  const rows = [
    event(1, 'old'),
    response(1, 'old'),
    event(2, 'repeat'),
    response(2, 'repeat'),
    event(3, 'repeat'),
    response(3, 'repeat'),
    event(4, 'last\nsecond line'),
    response(4, 'last\nsecond line'),
    { ...event(5, 'metadata'), isMeta: true },
    {
      ...event(6, 'automated'),
      payload: { ...event(6, 'automated').payload, source: { kind: 'agent' } }
    },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'assistant' } }
  ]
  const { read } = await fixture(t, 'codex', rows)
  const value = await read()
  assert.deepEqual(
    value.inputs.map((i) => i.text),
    ['last\nsecond line', 'repeat', 'repeat']
  )
  assert.equal(new Set(value.inputs.map((i) => i.id)).size, 3)
  assert.deepEqual(await read(), value)
})

test('Codex paginated completed items, old wrapped and unwrapped user messages exclude nontext/model context', async (t) => {
  const { entry, root, path, read } = await fixture(t, 'codex', [
    { type: 'session_meta', payload: { id: 'one', history_mode: 'paginated' } },
    response(7, 'model copy'),
    event(7, 'duplicate event'),
    {
      timestamp: iso(8),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          id: 'visible',
          type: 'UserMessage',
          content: [
            { type: 'text', text: 'human' },
            { type: 'image', image_url: 'not text' }
          ]
        }
      }
    }
  ])
  assert.deepEqual(
    (await read()).inputs.map((i) => i.text),
    ['human']
  )
  await writeFile(
    path,
    [
      response(1, 'wrapped'),
      {
        timestamp: iso(2),
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'early' },
          { type: 'input_image', image_url: 'secret' },
          { type: 'input_text', text: '<skill>instructions</skill>' }
        ]
      },
      {
        timestamp: iso(3),
        type: 'message',
        role: 'system',
        content: [{ type: 'text', text: 'system' }]
      }
    ]
      .map(JSON.stringify)
      .join('\n') + '\n'
  )
  assert.deepEqual(
    (await read()).inputs.map((i) => i.text),
    ['early', 'wrapped']
  )
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'other' } }) + '\n')
  await assert.rejects(transcriptInputs(entry, [root]), /identity mismatch/)
})

test('Claude user strings, text blocks and human queued prompts exclude automation, tools, attachments and other sessions', async (t) => {
  const { read } = await fixture(t, 'claude', [
    claude(1, 'string'),
    claude(2, [
      { type: 'text', text: 'blocks' },
      { type: 'tool_result', content: 'tool secret' }
    ]),
    {
      type: 'attachment',
      uuid: 'queued',
      timestamp: iso(3),
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: 'queue',
        origin: { kind: 'human' }
      }
    },
    { ...claude(4, 'meta'), isMeta: true },
    { ...claude(5, 'synthetic'), isSynthetic: true },
    { ...claude(6, 'summary'), isCompactSummary: true },
    { ...claude(7, 'another'), sessionId: 'two' },
    claude(8, [
      { type: 'tool_result', content: 'tool' },
      { type: 'image', data: 'base64' }
    ]),
    {
      type: 'attachment',
      timestamp: iso(9),
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: 'agent queue',
        origin: { kind: 'agent' }
      }
    },
    {
      ...claude(10, 'assistant'),
      type: 'assistant',
      message: { role: 'assistant', content: 'assistant' }
    }
  ])
  assert.deepEqual(
    (await read()).inputs.map((i) => i.text),
    ['queue', 'blocks', 'string']
  )
})

test('transcript text/count bounds, UUID dedup, incomplete rows and containment', async (t) => {
  const rows = Array.from({ length: 20 }, (_, i) => claude(i, 'x'.repeat(TEXT_LIMIT + 1)))
  rows.push(claude(19, 'x'.repeat(TEXT_LIMIT + 1)))
  const { read, entry, root, path } = await fixture(t, 'claude', rows)
  const value = await read()
  assert.equal(value.inputs.length, 3)
  assert.equal(value.inputs[0].text.length, TEXT_LIMIT)
  assert.equal(
    value.inputs.every((i) => i.truncated),
    true
  )
  assert.equal(new Set(value.inputs.map((i) => i.id)).size, 3)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 80 * 1024)
  await writeFile(path, JSON.stringify(claude(30, 'incomplete')))
  assert.deepEqual((await read()).inputs, [])
  await mkdir(join(root, 'allowed'))
  await symlink(path, join(root, 'allowed', 'escape.jsonl'))
  await assert.rejects(
    transcriptInputs({ ...entry, path: join(root, 'allowed', 'escape.jsonl') }, [
      join(root, 'allowed')
    ]),
    /outside/
  )
})

function journal(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE journal_sessions (session_id TEXT, epoch TEXT);
    CREATE TABLE journal_rows (session_id TEXT, epoch TEXT, seq INTEGER, row_json TEXT);
    CREATE TABLE journal_outcome_epochs (session_id TEXT, epoch TEXT, generation INTEGER, format INTEGER, through_seq INTEGER, prefix_seq INTEGER);
    CREATE TABLE journal_outcomes (generation INTEGER, seq INTEGER, field TEXT, entry_key TEXT, format INTEGER, value_json TEXT, deleted INTEGER);
    CREATE INDEX outcomes ON journal_outcomes (generation, field, entry_key, seq);
    INSERT INTO journal_sessions VALUES ('chat', 'current');`)
  const row = (seq, value, epoch = 'current') =>
    db
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?)')
      .run('chat', epoch, seq, JSON.stringify({ v: 4, seq, ts: now + seq, ...value }))
  const item = (itemId, text, at = 0, extra = {}) => ({
    kind: 'item',
    itemId,
    observedAt: now + at,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }], ...extra }
  })
  const outcome = (seq, key, value, field = 'items', generation = 1, format = 2) =>
    db
      .prepare('INSERT INTO journal_outcomes VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        generation,
        seq,
        field,
        JSON.stringify(key),
        format,
        JSON.stringify(value),
        value === null ? 1 : 0
      )
  return { db, row, item, outcome }
}

test('native legacy revisions/tombstones and active epoch preserve repeats, text-only human inputs', (t) => {
  const { db, row, item } = journal(t)
  row(1, item('a', 'old', 1))
  row(2, item('b', 'repeat', 2))
  row(3, item('c', 'repeat', 3))
  row(4, item('d', 'latest\nline', 4))
  row(5, item('a', 'edited old', 1))
  row(6, item('tool', 'tool', 6, { role: 'tool' }))
  row(7, item('agent', 'agent', 7, { from: { kind: 'agent' } }))
  row(8, item('system', 'system', 8, { role: 'system' }))
  row(9, item('assistant', 'assistant', 9, { role: 'assistant' }))
  row(10, item('deleted', 'secret', 10))
  row(11, { kind: 'tombstone', itemId: 'deleted' })
  row(12, item('inactive', 'wrong epoch', 12), 'old')
  assert.deepEqual(
    journalInputs(db, 'chat').inputs.map((i) => i.text),
    ['latest\nline', 'repeat', 'repeat']
  )
})

test('native outcome formats 1/2 apply latest published values, deletion, aliases and prefix, never unpublished/inactive data', (t) => {
  const { db, row, item, outcome } = journal(t)
  row(1, item('kept', 'prefix', 1))
  row(2, item('deleted', 'deleted', 2))
  row(3, { kind: 'outcomes', v: 5 })
  db.exec("INSERT INTO journal_outcome_epochs VALUES ('chat', 'current', 1, 2, 8, 2)")
  outcome(3, 'deleted', null)
  outcome(4, 'repeat1', item('repeat1', 'repeat', 4), 'items', 1, 1)
  outcome(5, 'repeat2', item('repeat2', 'repeat', 5))
  outcome(6, 'repeat2', item('repeat2', 'updated', 5))
  outcome(7, 'echo', item('echo', 'updated', 5))
  outcome(8, 'echo', ['echo', 'repeat2'], 'aliases')
  outcome(9, 'unpublished', item('unpublished', 'secret', 9))
  outcome(10, 'inactive', item('inactive', 'secret', 10), 'items', 99)
  assert.deepEqual(
    journalInputs(db, 'chat').inputs.map((i) => i.text),
    ['updated', 'repeat', 'prefix']
  )
  db.exec('UPDATE journal_outcome_epochs SET format = 99')
  assert.throws(() => journalInputs(db, 'chat'), /Unsupported/)
})

test('native reads fail honestly at row/byte limits instead of returning outdated or resurrected prompts', (t) => {
  const { db, row, item } = journal(t)
  row(1, item('huge', 'x'.repeat(1024 * 1024)))
  assert.throws(() => journalInputs(db, 'chat'), /limit/)
  db.exec('DELETE FROM journal_rows')
  for (let i = 0; i < 2001; i++) row(i, item(`m${i}`, 'bounded', i))
  assert.throws(() => journalInputs(db, 'chat'), /limit/)
})

test('detail fetch uses direct durable identity across merges/reused panes; prompts never persist or reach children', async (t) => {
  const { entry, root, path } = await fixture(t, 'codex', [event(1, 'private text')])
  const store = new ActivityStore(now)
  const reader = new OrcaLogReader(store, [root])
  t.after(() => reader.close())
  const status = (id) => ({
    receivedAt: now,
    payload: { state: 'working' },
    providerSession: { agent: 'codex', id, transcriptPath: path }
  })
  importStatusRow(store, 'same-pane', status('one'), now)
  reader.transcripts.set(path, entry)
  const service = new RecentInputs(reader)
  assert.equal((await service.read({ agentId: entry.id })).inputs[0].text, 'private text')
  store.agent('dispatch:task')
  store.merge(entry.id, 'dispatch:task')
  assert.equal((await service.read({ agentId: 'dispatch:task' })).inputs[0].text, 'private text')
  importStatusRow(store, 'same-pane', status('two'), now)
  assert.equal((await service.read({ agentId: 'native:codex:two' })).unavailable, true)
  store.agent('child:one', {
    parentId: 'dispatch:task',
    provider: 'codex',
    providerSessionId: 'child'
  })
  assert.equal((await service.read({ agentId: 'child:one' })).unavailable, true)
  assert.equal((await service.read({ agentId: 'pane:same-pane' })).unavailable, true)
  assert.equal((await service.read({ agentId: 'dispatch:task', path })).unavailable, true)
  assert.equal(JSON.stringify(store.serialize()).includes('private text'), false)
  assert.equal(JSON.stringify(store.snapshot(now)).includes('private text'), false)
  const restored = new ActivityStore(now)
  restored.restore(store.serialize(), now)
  const restarted = new RecentInputs(new OrcaLogReader(restored, [root]))
  assert.equal((await restarted.read({ agentId: 'dispatch:task' })).unavailable, true)
  restarted.reader.transcripts.set(path, entry)
  restarted.cached = null
  assert.equal((await restarted.read({ agentId: 'dispatch:task' })).inputs[0].text, 'private text')
})

test('collector discovers input sources, scans remain idempotent, and successor assignments cannot reuse another transcript', async (t) => {
  const { root, path } = await fixture(t, 'claude', [claude(1, 'human input')])
  await mkdir(join(root, 'agent-hooks'))
  const statusPath = join(root, 'agent-hooks', 'last-status.json')
  const status = (id) =>
    JSON.stringify({
      entries: {
        pane: {
          agent: 'claude',
          receivedAt: now,
          payload: { state: 'working' },
          providerSession: { agent: 'claude', id, transcriptPath: path }
        }
      }
    })
  await writeFile(statusPath, status('one'))
  const store = new ActivityStore(now)
  const reader = new OrcaLogReader(store, [root])
  t.after(() => reader.close())
  const service = new RecentInputs(reader)
  await reader.scan(now)
  const first = await service.read({ agentId: 'native:claude:one' })
  assert.deepEqual(
    first.inputs.map((i) => i.text),
    ['human input']
  )
  await reader.scan(now)
  service.cached = null
  assert.deepEqual(await service.read({ agentId: 'native:claude:one' }), first)
  await writeFile(statusPath, status('two'))
  await reader.scan(now)
  service.cached = null
  assert.deepEqual((await service.read({ agentId: 'native:claude:two' })).inputs, [])
  assert.equal((await service.read({ agentId: 'native:claude:one' })).unavailable, true)
  assert.equal(JSON.stringify(store.serialize()).includes('human input'), false)
})

test('paginated/user-event metadata never falls back to model-only prompt copies', async (t) => {
  const { read } = await fixture(t, 'codex', [
    response(1, 'automated copy'),
    { ...event(1, 'automated'), isSynthetic: true }
  ])
  assert.deepEqual((await read()).inputs, [])
})

test('native aliases cannot resurrect deleted or source-marked automated inputs', (t) => {
  const { db, row, item, outcome } = journal(t)
  row(1, { kind: 'outcomes', v: 5 })
  db.exec("INSERT INTO journal_outcome_epochs VALUES ('chat', 'current', 1, 2, 7, 0)")
  outcome(1, 'automated', item('automated', 'agent text', 1, { from: { kind: 'agent' } }))
  outcome(2, 'echo', item('echo', 'agent text', 1))
  outcome(3, 'echo', ['echo', 'automated'], 'aliases')
  outcome(4, 'deleted', null)
  outcome(5, 'deleted-echo', item('deleted-echo', 'deleted text', 2))
  outcome(6, 'deleted-echo', ['deleted-echo', 'deleted'], 'itemEchoes')
  outcome(7, 'human', item('human', 'person', 3))
  assert.deepEqual(
    journalInputs(db, 'chat').inputs.map((i) => i.text),
    ['person']
  )
})

test('published alias deletion overrides an old inline echo relationship', (t) => {
  const { db, row, item, outcome } = journal(t)
  row(1, item('first', 'repeat', 1))
  row(2, { ...item('second', 'repeat', 2), echoOf: 'first' })
  row(3, { kind: 'outcomes', v: 5 })
  db.exec("INSERT INTO journal_outcome_epochs VALUES ('chat', 'current', 1, 2, 4, 2)")
  outcome(4, 'second', null, 'aliases')
  assert.deepEqual(
    journalInputs(db, 'chat').inputs.map((i) => i.id),
    ['second', 'first']
  )
})
