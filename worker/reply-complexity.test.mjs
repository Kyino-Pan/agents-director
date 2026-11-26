import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './activity-store.mjs'
import { createOmissionReplies } from './snapshot-omissions.mjs'
import { prepareSnapshotReply, replyCost, replyFits } from './snapshot-reply.mjs'
import { segmentAt } from '../timeline-evidence.mjs'

const NOW = Date.parse('2026-11-26T10:00:00Z')
const options = { hideShortTasks: false, view: { hours: 1, end: NOW } }

function events(count) {
  const store = new ActivityStore(NOW - 86400000)
  for (let i = 0; i < 160; i++) {
    const id = 'a' + String(i).padStart(3, '0')
    store.agent(id, { label: id, sessionId: id, provider: 'codex', workspace: 'qa' })
    store.point(id, id, NOW - 86400000, 'unknown', 'history', NOW)
  }
  store.agent('z', { label: 'z', sessionId: 'z', provider: 'codex', workspace: 'qa' })
  for (let i = 0; i < count; i++) {
    const at = NOW - 600000 + i * 80
    store.point('event-' + i, 'z', at, i % 2 ? 'done' : 'working', 'live', at)
  }
  return store
}

function request(store, opts = options, frame = 'editor') {
  const omissions = createOmissionReplies()
  const prepare = ({ pinnedProjects: _projects, ...snapshot }) => omissions.prepare(snapshot, frame)
  const reply = prepareSnapshotReply(
    store,
    NOW,
    opts,
    prepare,
    (reply) => replyFits(reply) && omissions.fits(frame, reply.omissionToken)
  )
  const extra = reply.omissionToken ? omissions.take(frame, reply.omissionToken) : { rows: [] }
  assert.ok(extra.rows)
  return { reply, extra }
}

test('many instant observations constrain optional structure independently of reply bytes', () => {
  for (const count of [5666, 5667, 5668, 6000]) {
    const store = events(count)
    const raw = store.serialize()
    const full = store.snapshot(NOW, options)
    // Short fields fit the byte estimate; object/array volume needs its own guard.
    assert.ok(replyCost(full).bytes < 1024 * 1024 - 4096)
    assert.ok(!replyFits(full))
    for (const frame of ['editor', false]) {
      const { reply } = request(store, options, frame)
      assert.ok(replyFits(reply))
      assert.ok(reply.agents.reduce((n, a) => n + a.segments.length, 0) < 4000)
      const lane = reply.agents.find((a) => a.id === 'z')
      assert.equal(lane.stateEvents.length, count)
      assert.deepEqual(lane.stateEvents, full.agents.find((a) => a.id === 'z').stateEvents)
      assert.ok(lane.omittedSegments > 0 && lane.omittedRanges.length)
      assert.equal(
        lane.segments.some((s) => s.state === 'working'),
        false
      )
    }
    assert.deepEqual(store.serialize(), raw)
  }
})

test('instant events plus 600 messages preserve every message and reserved endpoint interval', () => {
  const store = events(5667)
  for (let i = 0; i < 600; i++) {
    const at = NOW - 600000 + i * 640
    store.message({
      id: 'mail-' + i,
      from: 'a000',
      to: 'z',
      at,
      deliveredAt: at + 20,
      type: 'Mailbox received',
      subject: 'original subject',
      body: 'original body'
    })
  }
  const raw = store.serialize()
  const full = store.snapshot(NOW, options)
  const { reply } = request(store)
  assert.ok(replyFits(reply))
  assert.deepEqual(reply.messages, full.messages)
  assert.equal(reply.messages.length, 600)
  assert.equal(reply.agents.find((a) => a.id === 'z').stateEvents.length, 5667)
  for (const mail of reply.messages)
    for (const [id, at] of [
      [mail.from, mail.at],
      [mail.to, mail.at],
      [mail.to, mail.deliveredAt]
    ]) {
      const original = full.agents.find((a) => a.id === id)
      const retained = reply.agents.find((a) => a.id === id)
      assert.deepEqual(segmentAt(retained.segments, at), segmentAt(original.segments, at))
    }
  assert.deepEqual(store.serialize(), raw)
})

test('reduced fill prefers bounded activity over optional gaps and Done without changing reservations', () => {
  const store = new ActivityStore(NOW)
  for (let i = 0; i < 3; i++) {
    const id = String(i)
    store.agent(id, { label: id })
    store.point('work-' + i, id, NOW - 10000, 'working', 'live', NOW - 9000)
    store.point('done-' + i, id, NOW - 8000, 'done', 'live', NOW - 7000)
  }
  // Pin a non-active interval through an observed message; this wins first.
  store.message({ id: 'mail', from: '0', to: '1', at: NOW - 7500, type: 'Send accepted' })
  const opts = { ...options, segmentBudget: 8 }
  const chronological = store.snapshot(NOW, opts)
  const preferred = store.snapshot(NOW, { ...opts, preferActivity: true })
  assert.equal(
    chronological.agents.flatMap((a) => a.segments).filter((s) => s.state === 'working').length,
    0
  )
  assert.equal(
    preferred.agents.flatMap((a) => a.segments).filter((s) => s.state === 'working').length,
    3
  )
  assert.equal(preferred.agents.flatMap((a) => a.segments).length, 8)
  assert.deepEqual(preferred.messages, chronological.messages)
  for (const lane of preferred.agents) {
    assert.deepEqual(
      lane.segments.at(-1),
      chronological.agents.find((a) => a.id === lane.id).segments.at(-1)
    )
    if (lane.id !== '2') assert.equal(segmentAt(lane.segments, NOW - 7500).state, 'done')
    assert.ok(lane.omittedRanges.length)
  }
})

test('full 8196-point omission follow-up fits independently and recombines exact coverage notices', () => {
  const store = new ActivityStore(NOW)
  for (let i = 0; i < 8196; i++) {
    const id = 'lane-' + (i % 64)
    const at = NOW - 650000 + Math.floor(i / 64) * 5000
    store.point(String(i), id, at, 'working', 'live', at + 1000)
  }
  const raw = store.serialize()
  const expected = store.snapshot(NOW, options)
  const { reply, extra } = request(store)
  assert.ok(replyFits(reply) && replyFits(extra))
  assert.ok(extra.rows.length)
  const merged = [...reply.agents]
  for (const { index, ...metadata } of extra.rows) merged[index] = { ...merged[index], ...metadata }
  assert.deepEqual(merged, expected.agents)
  assert.deepEqual(store.serialize(), raw)
  const omissions = createOmissionReplies()
  const first = omissions.prepare(expected, 'frame')
  assert.equal(omissions.fits('frame', first.omissionToken), true)
  omissions.prepare(expected, 'frame')
  assert.equal(omissions.fits('frame', first.omissionToken), false)
})
