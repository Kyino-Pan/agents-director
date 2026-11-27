import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './activity-store.mjs'
import { createOmissionReplies } from './snapshot-omissions.mjs'
import { prepareSnapshotReply } from './snapshot-reply.mjs'
import { segmentAt } from '../timeline-evidence.mjs'
import { terminalKey } from '../pin-identity.mjs'

const NOW = Date.parse('2026-11-26T10:00:00Z')
const options = { view: { hours: 1, end: NOW }, hideShortTasks: false }

function crowded(long = true) {
  const store = new ActivityStore(NOW - 86400000)
  const ids = []
  for (let n = 0; n < 264; n++) {
    const workspace = 'workspace-' + n + (long ? 'w'.repeat(220) : '')
    const id = 'public:' + JSON.stringify([workspace, 'codex', 'session-' + n])
    ids.push(id)
    store.agent(id, {
      workspace,
      sessionId: 'session-' + n,
      label: (n < 200 ? 'A' : 'Z') + String(n).padStart(3, '0') + 'q'.repeat(156)
    })
    if (n < 200) store.point(id, id, NOW - 86400000, 'unknown', 'history', NOW)
    else
      for (let i = 0; i < 100; i++) {
        const at = NOW - 600000 + i * 5000
        store.point(
          id + i,
          id,
          at,
          ['blocked', 'done', 'blocked', 'waiting'][i % 4],
          'live',
          at + 1000
        )
      }
  }
  for (let i = 0; i < 605; i++)
    store.message({
      id: 'mail-' + i,
      from: ids[200],
      to: ids[263],
      at: NOW - 5000 + i,
      deliveredAt: NOW - 4000 + i,
      type: 'Mailbox received',
      subject: 's'.repeat(160),
      body: 'b'.repeat(400)
    })
  store.agent(ids[263], { parentId: ids[262], spawnedAt: NOW - 300000 })
  return store
}

function request(store, options, frame) {
  const omissions = createOmissionReplies()
  const prepare = ({ pinnedProjects: _pinnedProjects, ...snapshot }) => ({
    ...omissions.prepare(snapshot, frame),
    headingVersion: null,
    pinVersion: 0,
    language: 'en',
    preferencesUnavailable: false
  })
  const reply = prepareSnapshotReply(store, NOW, options, prepare)
  const rows = reply.omissionToken ? omissions.take(frame, reply.omissionToken).rows : []
  assert.ok(rows)
  return { reply, rows }
}

test('long replies reduce interval fill with exact notices, preserving messages, pins and endpoints', () => {
  const store = crowded()
  const raw = store.serialize()
  const pinnedTerminals = [terminalKey(raw.agents[199])]
  const opts = { ...options, pinnedTerminals }
  const full = store.snapshot(NOW, opts)
  const { reply, rows } = request(store, opts, 'panel')
  const count = (snapshot) => snapshot.agents.reduce((n, a) => n + a.segments.length, 0)
  assert.equal(count(full), 4000)
  assert.ok(count(reply) < 4000 && count(reply) > 160)
  assert.equal(reply.limited, true)
  assert.deepEqual(reply.messages, full.messages)
  assert.equal(reply.messages.length, 600)
  assert.equal(reply.agents[0].pinned, true)
  assert.deepEqual(
    reply.agents.map((a) => a.id),
    full.agents.map((a) => a.id)
  )
  for (const lane of reply.agents) {
    const original = full.agents.find((a) => a.id === lane.id)
    assert.deepEqual(lane.stateEvents, original.stateEvents)
    assert.equal(lane.parentId, original.parentId)
    assert.equal(lane.spawnedAt, original.spawnedAt)
    assert.deepEqual(lane.segments.at(-1), original.segments.at(-1))
    // Include the original 4000-budget omissions in the accounting.
    const all = original.segments
    const metadata = rows.find((row) => reply.agents[row.index].id === lane.id)
    if (all.length > lane.segments.length) {
      assert.ok(metadata?.omittedSegments > 0)
      for (const segment of all) {
        if (lane.segments.some((s) => s.start === segment.start && s.end === segment.end)) continue
        assert.ok(
          metadata.omittedRanges.some((r) => r.start <= segment.start && r.end >= segment.end)
        )
        if (['working', 'blocked', 'waiting'].includes(segment.state))
          assert.ok(
            metadata.omittedActivity.some(
              (start, i, bounds) =>
                i % 2 === 0 && start <= segment.start && bounds[i + 1] >= segment.end
            )
          )
      }
    }
  }
  for (const mail of reply.messages)
    for (const [id, at] of [
      [mail.from, mail.at],
      [mail.to, mail.at],
      [mail.to, mail.deliveredAt]
    ]) {
      const old = full.agents.find((a) => a.id === id)
      const lane = reply.agents.find((a) => a.id === id)
      assert.ok(lane)
      assert.deepEqual(segmentAt(lane.segments, at), segmentAt(old.segments, at))
    }
  assert.deepEqual(store.serialize(), raw)
})

test('ordinary and narrow replies retain the original full intervals; legacy callers retain notices', () => {
  for (const [store, opts] of [
    [crowded(false), options],
    [crowded(), { ...options, view: { hours: 1 / 60, end: NOW - 300000 } }]
  ]) {
    const expected = store.snapshot(NOW, opts)
    const { reply, rows } = request(store, opts, 'editor')
    for (const { index, ...metadata } of rows) Object.assign(reply.agents[index], metadata)
    assert.deepEqual(reply.agents, expected.agents)
    assert.deepEqual(reply.messages, expected.messages)
  }
  const legacy = request(crowded(), options).reply
  assert.equal(legacy.omissionToken, undefined)
  assert.ok(legacy.agents.some((a) => a.omittedSegments && a.omittedRanges.length))
  assert.equal(legacy.messages.length, 600)
})

test('protected evidence above the fill estimate stays intact for public bridge validation', () => {
  for (const kind of ['messages', 'events']) {
    const store = crowded()
    if (kind === 'messages')
      for (const mail of store.messages.values()) {
        mail.subject = '界'.repeat(160)
        mail.body = '界'.repeat(400)
      }
    else {
      store.points.clear()
      const id = [...store.agents.keys()].at(-1)
      for (let i = 0; i < 8196; i++)
        store.point(
          'event-' + i,
          id,
          NOW - 10000 + i,
          i % 2 ? 'done' : 'blocked',
          'live',
          NOW - 10000 + i
        )
    }
    store.prune(NOW)
    const raw = store.serialize()
    const expected = store.snapshot(NOW, { ...options, segmentBudget: 0 })
    const { reply, rows } = request(store, options, 'panel')
    for (const { index, ...metadata } of rows) Object.assign(reply.agents[index], metadata)
    assert.deepEqual(reply.agents, expected.agents)
    assert.deepEqual(reply.messages, expected.messages)
    assert.deepEqual(store.serialize(), raw)
  }
})
