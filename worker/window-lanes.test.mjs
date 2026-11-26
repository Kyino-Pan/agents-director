import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './activity-store.mjs'
import { terminalKey } from '../pin-identity.mjs'
import { hasWindowActivity } from '../timeline-evidence.mjs'

const NOW = Date.parse('2026-11-26T10:00:00Z')
const view = { hours: 1, end: NOW }
const ids = (snapshot) => snapshot.agents.map((agent) => agent.id)
const options = { view, hideShortTasks: false }

function summaries(count = 200) {
  const store = new ActivityStore(NOW - 86400000)
  for (let i = 0; i < count; i++) {
    const id = 'a-' + String(i).padStart(3, '0')
    store.agent(id, { label: id, sessionId: id, provider: 'codex', workspace: 'test' })
    store.point(id, id, NOW - 86400000, 'unknown', 'history', NOW)
  }
  return store
}

function observed(store, id, state = 'working', at = NOW - 600000, until = NOW) {
  store.agent(id, { label: id, sessionId: id, provider: 'codex', workspace: 'test' })
  store.point(id + '-point', id, at, state, 'live', until)
}

test('windowed lane places prefer the same active evidence as the panel, not summary lifetimes', () => {
  const store = summaries()
  for (const state of ['working', 'blocked', 'waiting']) observed(store, 'z-' + state, state)
  observed(store, 'z-before', 'working', NOW - 7200000, NOW - 3600000)
  observed(store, 'z-after', 'working', NOW + 1, NOW + 1000)
  observed(store, 'z-done', 'done')
  observed(store, 'z-instant', 'working', NOW, NOW)
  observed(store, 'z-crossing', 'working', NOW - 3600001, NOW - 3599999)
  const raw = store.serialize()
  const snapshot = store.snapshot(NOW, options)
  assert.equal(snapshot.agents.length, 160)
  for (const id of ['z-working', 'z-blocked', 'z-waiting', 'z-instant', 'z-crossing'])
    assert.ok(ids(snapshot).includes(id), id)
  for (const id of ['z-before', 'z-after', 'z-done']) assert.ok(!ids(snapshot).includes(id), id)
  assert.equal(snapshot.limited, true)
  assert.deepEqual(store.serialize(), raw)
  assert.deepEqual(
    ids(snapshot),
    [...ids(snapshot)].sort((a, b) => a.localeCompare(b))
  )
})

test('oversubscribed activity uses stable label/id order after manual pins and unpinning', () => {
  function source(reverse) {
    const store = summaries()
    const order = Array.from({ length: 165 }, (_, i) => i)
    for (const i of reverse ? order.reverse() : order) {
      const id = 'z-' + String(i).padStart(3, '0')
      observed(store, id)
      store.agent(id, { label: 'Same label' })
    }
    return store
  }
  const store = source(false)
  const unpinned = store.snapshot(NOW, options)
  assert.deepEqual(ids(unpinned), ids(source(true).snapshot(NOW, options)))
  assert.equal(unpinned.agents.length, 160)
  assert.equal(ids(unpinned).at(-1), 'z-159')
  const pin = terminalKey(store.agents.get('a-199'))
  const pinned = store.snapshot(NOW, { ...options, pinnedTerminals: [pin] })
  assert.equal(pinned.agents[0].id, 'a-199')
  assert.equal(pinned.agents[0].pinned, true)
  assert.equal(ids(pinned).at(-1), 'z-158')
  assert.deepEqual(ids(store.snapshot(NOW, options)), ids(unpinned))
  const full = store.snapshot(NOW, {
    ...options,
    pinnedTerminals: [...store.agents.values()].slice(0, 161).map(terminalKey)
  })
  assert.equal(full.agents.length, 160)
  assert.ok(full.agents.every((agent) => agent.pinned && agent.id.startsWith('a-')))
})

test('pins, verified mail pairs and spawn pairs keep reservations ahead of active lanes', () => {
  const store = summaries()
  for (let i = 0; i < 160; i++) observed(store, 'z-' + String(i).padStart(3, '0'))
  store.message({
    id: 'verified',
    from: 'a-190',
    to: 'a-191',
    at: NOW - 1000,
    type: 'Send accepted'
  })
  store.agent('a-193', { parentId: 'a-192', spawnedAt: NOW - 2000 })
  const pinnedTerminals = [terminalKey(store.agents.get('a-199'))]
  const snapshot = store.snapshot(NOW, { ...options, pinnedTerminals })
  for (const id of ['a-199', 'a-190', 'a-191', 'a-192', 'a-193'])
    assert.ok(ids(snapshot).includes(id), id)
  assert.equal(snapshot.agents.filter((a) => a.id.startsWith('z-')).length, 155)
  assert.equal(snapshot.messages.length, 1)
  const crowdedPins = [...store.agents.values()].slice(0, 157).map(terminalKey)
  const crowded = store.snapshot(NOW, { ...options, pinnedTerminals: crowdedPins })
  assert.equal(crowded.messages.length, 1)
  assert.equal(ids(crowded).includes('a-192'), false)
  assert.equal(ids(crowded).includes('a-193'), false)
  assert.equal(crowded.agents.filter((a) => a.id.startsWith('z-')).length, 1)
})

test('unreserved attempts keep fallback selection and cannot displace observed activity', () => {
  const store = summaries()
  for (let i = 0; i < 160; i++) observed(store, 'z-' + String(i).padStart(3, '0'))
  for (const id of ['b-attempt-from', 'b-attempt-to']) observed(store, id, 'unknown')
  const attempts = [
    {
      id: 'pending',
      from: 'b-attempt-from',
      to: 'b-attempt-to',
      at: NOW - 1000,
      type: 'Send attempted'
    }
  ]
  const snapshot = store.snapshot(NOW, { ...options, attempts })
  assert.ok(snapshot.agents.every((a) => a.id.startsWith('z-')))
  assert.equal(snapshot.messages.length, 0)
  const fullPins = [...store.agents.values()].slice(0, 160).map(terminalKey)
  const pinned = store.snapshot(NOW, { ...options, attempts, pinnedTerminals: fullPins })
  assert.equal(pinned.messages.length, 0)
  assert.ok(pinned.agents.every((a) => a.pinned))
})

test('short-task filtering still precedes activity priority and a pin remains its explicit exception', () => {
  const store = summaries()
  observed(store, 'z-long')
  observed(store, 'z-short', 'working', NOW - 120000, NOW - 60000)
  store.point('short-finish', 'z-short', NOW - 60000, 'done', 'live', NOW)
  store.message({
    id: 'short-mail',
    from: 'a-000',
    to: 'z-short',
    at: NOW - 90000,
    type: 'Send accepted'
  })
  const raw = store.serialize()
  assert.ok(ids(store.snapshot(NOW, options)).includes('z-short'))
  const hidden = store.snapshot(NOW, { ...options, hideShortTasks: true })
  assert.equal(hidden.hiddenShortTasks, 1)
  assert.equal(ids(hidden).includes('z-short'), false)
  assert.equal(hidden.messages.length, 0)
  const pinned = store.snapshot(NOW, {
    ...options,
    hideShortTasks: true,
    pinnedTerminals: [terminalKey(store.agents.get('z-short'))]
  })
  assert.equal(pinned.agents[0].id, 'z-short')
  assert.equal(pinned.agents[0].pinnedShortTask, true)
  assert.equal(pinned.messages.length, 1)
  assert.deepEqual(store.serialize(), raw)
})

test('anchored pause, pan and wide windows use their own evidence; legacy calls keep selection', () => {
  const store = summaries()
  observed(store, 'z-earlier', 'working', NOW - 4 * 3600000, NOW - 3 * 3600000)
  observed(store, 'z-current')
  const earlier = { hours: 1, end: NOW - 3 * 3600000 }
  const before = store.snapshot(NOW, { ...options, view: earlier })
  assert.ok(ids(before).includes('z-earlier'))
  assert.ok(!ids(before).includes('z-current'))
  observed(store, 'z-future', 'working', NOW + 1000, NOW + 2000)
  assert.deepEqual(ids(store.snapshot(NOW + 600000, { ...options, view: earlier })), ids(before))
  const recent = ids(store.snapshot(NOW, options))
  assert.ok(recent.includes('z-current') && !recent.includes('z-earlier'))
  const wide = ids(store.snapshot(NOW, { ...options, view: { hours: 6, end: NOW } }))
  assert.ok(wide.includes('z-current') && wide.includes('z-earlier'))
  for (const view of [undefined, {}, { hours: 0 }, { hours: 1, end: 'invalid' }]) {
    const legacy = store.snapshot(NOW, { ...options, view })
    assert.equal(legacy.view, undefined)
    assert.ok(legacy.agents.every((a) => a.id.startsWith('a-')))
  }
})

test('shared eligibility respects active instants and exact omitted-activity boundaries', () => {
  const eligible = (agent, start, end) => Boolean(hasWindowActivity(agent, start, end))
  const agent = { segments: [], omittedActivity: [100, 200] }
  assert.equal(eligible(agent, 0, 100), false)
  assert.equal(eligible(agent, 200, 300), false)
  assert.equal(eligible(agent, 100, 200), true)
  for (const state of ['working', 'blocked', 'waiting', 'done', 'unknown']) {
    const lane = { segments: [], stateEvents: [{ at: 100, state, completionSince: 90 }] }
    assert.equal(eligible(lane, 100, 200), ['working', 'blocked', 'waiting'].includes(state))
    assert.equal(eligible(lane, 0, 100), ['working', 'blocked', 'waiting'].includes(state))
    assert.equal(eligible(lane, 101, 200), false)
  }
})

test('activity priority keeps 8196 persistence independent from 4000 segment and 600 message replies', () => {
  const store = summaries()
  for (let lane = 0; lane < 64; lane++) {
    const id = 'z-' + String(lane).padStart(3, '0')
    store.agent(id, { label: id, sessionId: id })
    for (let i = 0; i < 100; i++) {
      const at = NOW - 600000 + i * 5000
      store.point(id + '-' + i, id, at, i % 2 ? 'done' : 'working', 'live', at + 1000)
    }
  }
  for (let i = 0; i < 605; i++)
    store.message({
      id: 'mail-' + i,
      from: 'z-000',
      to: 'z-063',
      at: NOW - 5000 + i,
      type: 'Send accepted'
    })
  const raw = store.serialize()
  const snapshot = store.snapshot(NOW, options)
  assert.equal(snapshot.agents.length, 160)
  assert.equal(snapshot.agents.filter((a) => a.id.startsWith('z-')).length, 64)
  assert.equal(snapshot.messages.length, 600)
  assert.equal(
    snapshot.agents.reduce((n, a) => n + a.segments.length, 0),
    4000
  )
  assert.equal(snapshot.messages[0].id, 'mail-5')
  assert.deepEqual(store.serialize(), raw)
})
