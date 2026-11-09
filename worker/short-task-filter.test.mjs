import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityStore, WINDOW_MS } from './activity-store.mjs'
import { importJournalRow, importTranscriptRow } from './orca-log-reader.mjs'

const NOW = Date.parse('2026-11-02T08:00:00Z')
const START = NOW - 3_600_000
const filtered = (store) => store.snapshot(NOW, { hideShortTasks: true })
const ids = (snapshot) => snapshot.agents.map((agent) => agent.id)

function work(store, id, start, end, suffix = '') {
  store.point(`${id}:work:${suffix}`, id, start, 'working', 'journal', end)
  store.point(`${id}:done:${suffix}`, id, end, 'done', 'journal')
}

test('strict threshold sums separate executions, merges overlap and excludes idle time', () => {
  const store = new ActivityStore(START)
  work(store, 'below', START, START + 179_999)
  work(store, 'equal', START, START + 180_000)
  work(store, 'above', START, START + 180_001)
  work(store, 'overlap', START, START + 160_000)
  store.point('overlap-copy', 'overlap', START + 10_000, 'working', 'live', START + 170_000)
  store.point('overlap-end', 'overlap', START + 170_000, 'done', 'live')
  work(store, 'idle', START, START + 60_000, 'first')
  work(store, 'idle', START + 900_000, START + 960_000, 'second')
  work(store, 'cumulative', START, START + 90_000, 'first')
  work(store, 'cumulative', START + 900_000, START + 990_000, 'second')
  const snapshot = filtered(store)
  assert.deepEqual(ids(snapshot), ['above', 'cumulative', 'equal'])
  assert.equal(snapshot.hiddenShortTasks, 3)
  assert.equal(store.snapshot(NOW).agents.length, 6)
})

test('active, approval, question and insufficient or ambiguous observations stay visible', () => {
  const store = new ActivityStore(START)
  for (const [id, state] of [
    ['active', 'working'],
    ['approval', 'blocked'],
    ['question', 'waiting'],
    ['unknown', 'unknown']
  ]) {
    work(store, id, START, START + 10_000)
    store.point(`${id}:current`, id, START + 20_000, state, 'live', NOW)
  }
  store.point('completion-only', 'completion-only', START, 'done', 'journal')
  store.point('unbounded', 'unbounded', START, 'working', 'journal')
  store.point('unbounded-end', 'unbounded', START + 1000, 'done', 'journal')
  store.point('zero', 'zero', START, 'working', 'journal', START)
  store.point('zero-end', 'zero', START + 1000, 'done', 'journal')
  work(store, 'unknown-gap', START, START + 1000)
  store.point('gap-start', 'unknown-gap', START + 2000, 'working', 'journal', START + 3000)
  store.point('gap-end', 'unknown-gap', START + 30_000, 'done', 'journal')
  store.point('explicit-unknown', 'unknown-gap', START + 3000, 'unknown', 'journal')
  work(store, 'conflict', START, START + 1000)
  store.point('conflicting-work', 'conflict', START + 1000, 'working', 'live', NOW)
  work(store, 'future', START, START + 1000)
  store.point('future-observation', 'future', NOW + 1000, 'working', 'live', NOW + 2000)
  assert.deepEqual(ids(filtered(store)), [
    'active',
    'approval',
    'completion-only',
    'conflict',
    'question',
    'unbounded',
    'unknown',
    'unknown-gap',
    'zero'
  ])
  // Known resolved waiting contributes no execution time, even with a large elapsed duration.
  store.point('wait-work', 'resolved', START, 'working', 'journal', START + 10_000)
  store.point('wait', 'resolved', START + 10_000, 'waiting', 'journal', START + 900_000)
  work(store, 'resolved', START + 900_000, START + 910_000)
  assert.equal(ids(filtered(store)).includes('resolved'), false)
})

test('an open journal turn or pending prompt survives another turn completion until resolved', () => {
  const store = new ActivityStore(START)
  const row = (itemId, body) => ({ kind: 'item', epoch: 'e', itemId, ts: START + 5000, body })
  const completed = row('finished', { kind: 'turn', startedAt: START, completedAt: START + 10_000 })
  const open = row('open', { kind: 'turn', startedAt: START })
  importJournalRow(store, 'parallel', completed, NOW)
  importJournalRow(store, 'parallel', open, NOW)
  assert.deepEqual(ids(filtered(store)), ['session:parallel'])
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  assert.deepEqual(ids(filtered(restored)), ['session:parallel'])
  open.body.completedAt = START + 10_000
  importJournalRow(restored, 'parallel', open, NOW)
  assert.deepEqual(ids(filtered(restored)), [])
  for (const kind of ['question', 'approval']) {
    const pending = row('prompt', { kind, resolution: { state: 'pending' } })
    importJournalRow(restored, kind, completed, NOW)
    importJournalRow(restored, kind, pending, NOW)
    assert.ok(ids(filtered(restored)).includes(`session:${kind}`))
    pending.body.resolution = { state: 'resolved', resolvedAt: START + 6000 }
    importJournalRow(restored, kind, pending, NOW)
    assert.equal(ids(filtered(restored)).includes(`session:${kind}`), false)
  }
})

test('completed Codex and Claude transcript turns hide and new work makes them reappear', () => {
  for (const provider of ['codex', 'claude']) {
    const store = new ActivityStore(START)
    const row = (at, done = false) =>
      provider === 'codex'
        ? {
            timestamp: at,
            type: 'event_msg',
            payload: { type: done ? 'task_complete' : 'task_started' }
          }
        : {
            timestamp: at,
            type: done ? 'assistant' : 'user',
            message: done ? { stop_reason: 'end_turn' } : { content: 'Run a scheduled task' }
          }
    importTranscriptRow(store, provider, provider, row(START), 'transcript')
    assert.deepEqual(ids(filtered(store)), [provider])
    importTranscriptRow(store, provider, provider, row(START + 1000, true), 'transcript')
    assert.deepEqual(ids(filtered(store)), [])
    assert.deepEqual(ids(store.snapshot(NOW)), [provider])
    importTranscriptRow(store, provider, provider, row(START + 10_000), 'transcript')
    assert.deepEqual(ids(filtered(store)), [provider])
  }
})

test('filter precedes all snapshot budgets, preserves children and removes dangling messages', () => {
  const store = new ActivityStore(START)
  for (let i = 0; i < 205; i++) {
    const id = `a-temp-${i}`
    store.agent(id, { label: id })
    for (let turn = 0; turn < 10; turn++) {
      work(store, id, START + turn * 1000, START + turn * 1000 + 100, String(turn))
    }
  }
  for (const id of ['z-long', 'z-child', 'z-other']) {
    store.agent(id, { label: id })
    work(store, id, START, START + 180_000)
  }
  store.agent('z-child', { parentId: 'a-temp-0', spawnedAt: START })
  store.agent('a-temp-0', { workspace: 'project-workspace' })
  store.projectCatalog.set('project-workspace', { projectId: 'p', projectName: 'Project' })
  for (let i = 0; i < 650; i++) {
    store.message({ id: `hidden-${i}`, from: 'a-temp-0', to: 'z-long', at: START + i })
  }
  store.message({ id: 'eligible', from: 'z-long', to: 'z-child', at: START })
  const before = store.serialize()
  assert.equal(store.snapshot(NOW).agents.length, 160)
  const snapshot = filtered(store)
  assert.deepEqual(ids(snapshot), ['z-child', 'z-long', 'z-other'])
  assert.equal(snapshot.hiddenShortTasks, 205)
  assert.equal(snapshot.limited, false)
  assert.ok(snapshot.agents.every((agent) => agent.segments.length === 2))
  assert.equal(snapshot.agents[0].parentId, 'a-temp-0')
  assert.equal(snapshot.agents[0].projectName, 'Project')
  assert.deepEqual(
    snapshot.messages.map((message) => message.id),
    ['eligible']
  )
  assert.deepEqual(store.serialize(), before)
  const restored = new ActivityStore(NOW)
  restored.restore(before, NOW)
  assert.deepEqual(ids(filtered(restored)), ids(snapshot))
  assert.equal(restored.snapshot(NOW, { hideShortTasks: false }).agents.length, 160)
})

test('classification ignores viewport options and retained incomplete history cannot become short', () => {
  const store = new ActivityStore(START)
  work(store, 'short', START, START + 1000)
  work(store, 'trimmed', NOW - WINDOW_MS - 10_000, NOW - WINDOW_MS - 1000, 'expired')
  work(store, 'trimmed', START, START + 1000, 'recent')
  const snapshot = filtered(store)
  assert.deepEqual(ids(snapshot), ['trimmed'])
  for (const options of [
    { hours: 1 / 12, width: 320 },
    { hours: 168, width: 1400, viewEnd: START + 500 }
  ]) {
    assert.deepEqual(store.snapshot(NOW, { hideShortTasks: true, ...options }), snapshot)
  }
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  assert.deepEqual(ids(filtered(restored)), ['trimmed'])
})
