import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from './activity-store.mjs'
import { importStatusRow } from './orca-log-reader.mjs'
import { SessionRouting } from './session-routing.mjs'
import activate, { deactivate } from './main.mjs'

const NOW = Date.parse('2026-11-11T13:00:00Z')
const time = (value) => Date.parse(`2026-11-11T${value}Z`)
const native = (id) => `native:devin:${id}`
const workspace = 'repo::/test'
const row = (id, at, state = 'working') => ({
  receivedAt: at,
  worktreeId: workspace,
  providerSession: { agent: 'devin', id },
  payload: { mainAgent: { state, stateStartedAt: at } }
})
function live(store, id, paneKey, at, state = 'working') {
  const key = `live:${paneKey}:${at}`
  store.point(key, native(id), at, state, 'live', NOW)
  store.points.get(key).paneKey = paneKey
  return key
}
async function collector(context, saved) {
  const directory = await mkdtemp(join(tmpdir(), 'activity-boundaries-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'agent-hooks'))
  const statuses = (entries) =>
    writeFile(join(directory, 'agent-hooks/last-status.json'), JSON.stringify({ entries }))
  await statuses({})
  const db = new DatabaseSync(join(directory, 'profile-state.db'))
  db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)')
  context.after(() => db.close())
  const catalog = (value) =>
    db
      .prepare("INSERT OR REPLACE INTO profile_state_documents VALUES ('workspaceSession', ?)")
      .run(JSON.stringify(value))
  const storage = new Map(
    saved
      ? [
          ['activity-v1:head', { version: 1, generation: 'a', chunks: 1 }],
          ['activity-v1:a:0', JSON.stringify(saved)]
        ]
      : []
  )
  const handlers = new Map()
  let receive
  const api = {
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => storage.set(key, value),
      delete: async (key) => storage.delete(key)
    },
    settings: { get: async () => directory },
    panels: { handle: (name, handler) => handlers.set(name, handler), post: () => {} },
    commands: { register: (name, handler) => handlers.set(name, handler) },
    events: {
      on: (_, handler) => {
        receive = handler
        return { dispose() {} }
      }
    }
  }
  context.after(() => deactivate())
  return {
    statuses,
    catalog,
    start: () => activate(api),
    receive: (event) => receive({ workspaceId: workspace, ...event }),
    refresh: () => handlers.get('refresh')(),
    snapshot: () => handlers.get('activity.snapshot')({ hideShortTasks: false }),
    saved: () => {
      const head = storage.get('activity-v1:head')
      return JSON.parse(
        Array.from({ length: head.chunks }, (_, i) =>
          storage.get(`activity-v1:${head.generation}:${i}`)
        ).join('')
      )
    }
  }
}

test('v0.1.5 live cache is bounded by explicit closed tabs without claiming approval completion', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: NOW })
  const store = new ActivityStore(NOW)
  const workAt = time('12:10:45.585')
  const waitAt = time('11:19:41.656')
  for (const [id, pane, at, state, observed] of [
    ['predecessor', 'closed:leaf', workAt, 'working', time('12:13:12.813')],
    ['approval', 'approval:leaf', waitAt, 'waiting', waitAt],
    ['successor', 'new:leaf', time('12:53:54.351'), 'done', NOW]
  ]) {
    store.agent(
      native(id),
      { provider: 'devin', providerSessionId: id, paneKey: pane, workspace },
      [`pane:${pane}`]
    )
    // The old cache has no pane provenance on status points and already overextended live until.
    store.point(`status:${native(id)}:${at}`, native(id), at, state, 'status-cache', observed)
    live(store, id, pane, at, state)
  }
  const originalCount = store.points.size
  const f = await collector(context, store.serialize())
  const closedAt = time('12:25:17.372')
  const approvalClosedAt = time('11:19:46.914')
  f.catalog({
    closedTerminalTabTombstonesByTabId: {
      closed: { worktreeId: workspace, closedAt },
      approval: { worktreeId: workspace, closedAt: approvalClosedAt },
      // A different workspace's record is not a closure of this successor.
      new: { worktreeId: 'repo::/other', closedAt: NOW - 1000 }
    }
  })
  await f.start()
  await f.refresh()
  const check = async () => {
    const agents = new Map((await f.snapshot()).agents.map((a) => [a.id, a]))
    for (const [id, at, state] of [
      ['predecessor', closedAt, 'working'],
      ['approval', approvalClosedAt, 'waiting']
    ]) {
      const segments = agents.get(native(id)).segments
      assert.equal(segments.find((s) => s.state === state).end, at)
      assert.deepEqual(segments.at(-1), { start: at, end: NOW, state: 'unknown', source: 'gap' })
      assert.ok(segments.every((s) => s.state !== 'done'))
    }
    assert.equal(agents.get(native('successor')).segments.at(-1).state, 'done')
  }
  await check()
  await deactivate()
  assert.equal(f.saved().points.length, originalCount)
  // Once repaired, the saved bounds survive reload even if a later source read lacks tombstones.
  f.catalog({})
  await f.start()
  await f.refresh()
  await check()
})

test('ownership follows each observation when a conversation appears in multiple panes', () => {
  const store = new ActivityStore(NOW)
  const first = NOW - 30000
  importStatusRow(store, 'one:leaf', row('old', first), NOW)
  const old = live(store, 'old', 'one:leaf', first)
  importStatusRow(store, 'two:leaf', row('old', first), NOW)
  const other = live(store, 'old', 'two:leaf', first)
  importStatusRow(store, 'one:leaf', row('new', NOW - 10000), NOW)
  const next = live(store, 'new', 'one:leaf', NOW - 10000)
  // Repeated scans may finish with old's latest metadata on its other pane.
  for (let i = 0; i < 2; i++) {
    importStatusRow(store, 'two:leaf', row('old', first), NOW)
    const routing = new SessionRouting(store)
    assert.equal(routing.owner(undefined, 'one:leaf', first + 1), native('old'))
    routing.repairLivePoints()
  }
  assert.equal(store.points.get(old).until, NOW - 10000)
  assert.equal(store.points.get(old).agentId, native('old'))
  assert.equal(store.points.get(other).until, NOW)
  assert.equal(store.points.get(next).agentId, native('new'))
  assert.equal(store.points.get(next).until, NOW)
  assert.equal(
    [...store.points.values()].filter(
      (p) => p.source === 'status-cache' && p.agentId === native('old')
    ).length,
    2
  )
  const restored = new ActivityStore(NOW)
  restored.restore(store.serialize(), NOW)
  new SessionRouting(restored).repairLivePoints()
  assert.equal(restored.points.get(old).until, NOW - 10000)
  assert.equal(restored.points.get(other).until, NOW)
  assert.equal(restored.agents.size, 2)
})

test('status bounds survive source reimport after restore without closure records', async (context) => {
  for (const legacy of [false, true]) {
    await context.test(legacy ? 'legacy key migration' : 'existing pane key', () => {
      const store = new ActivityStore(NOW)
      const start = NOW - 30000
      const closedAt = NOW - 10000
      const status = { ...row('one', start, legacy ? 'waiting' : 'working'), receivedAt: NOW }
      const key = `status:tab:leaf:${native('one')}:${start}`
      const legacyKey = `status:${native('one')}:${start}`
      importStatusRow(store, 'tab:leaf', status, NOW)
      store.terminalClosures.set(`${workspace}:tab`, closedAt)
      new SessionRouting(store).repairLivePoints()
      if (legacy) {
        const point = store.points.get(key)
        store.points.delete(key)
        point.id = legacyKey
        delete point.paneKey
        store.points.set(legacyKey, point)
      }
      const restored = new ActivityStore(NOW)
      restored.restore(store.serialize(), NOW)
      assert.equal(restored.terminalClosures.size, 0)
      for (let pass = 0; pass < 2; pass++) {
        importStatusRow(restored, 'tab:leaf', status, NOW)
        new SessionRouting(restored).repairLivePoints()
        assert.equal(restored.points.get(key).until, closedAt)
        assert.equal(restored.points.get(key).ownershipUntil, closedAt)
        assert.equal(restored.points.size, 1)
      }
      assert.equal(restored.points.has(legacyKey), false)
      assert.equal(restored.snapshot(NOW).agents[0].segments.at(-1).state, 'unknown')
    })
  }
})

test('legacy bounds are not transferred to another pane of the same conversation', () => {
  const store = new ActivityStore(NOW)
  const start = NOW - 30000
  const id = native('one')
  const legacyKey = `status:${id}:${start}`
  store.agent(id, { providerSessionId: 'one', paneKey: 'old:leaf', workspace })
  store.point(legacyKey, id, start, 'working', 'status-cache', NOW - 10000)
  store.points.get(legacyKey).ownershipUntil = NOW - 10000
  for (let pass = 0; pass < 2; pass++) {
    importStatusRow(store, 'new:leaf', { ...row('one', start), receivedAt: NOW }, NOW)
    assert.equal(store.points.get(`status:new:leaf:${id}:${start}`).until, NOW)
    assert.equal(store.points.get(`status:new:leaf:${id}:${start}`).ownershipUntil, undefined)
    assert.equal(store.points.get(legacyKey).ownershipUntil, NOW - 10000)
  }
})

test('same-state successor events survive scan races and completion stops extension, while pending work has no timeout', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = await collector(context)
  await f.statuses({ 'pane:leaf': row('old', NOW - 30000) })
  await f.start()
  const event = (paneKey, at, state = 'working') => ({
    paneKey,
    receivedAt: at,
    state,
    mainAgent: { state, stateStartedAt: at }
  })
  f.receive(event('pane:leaf', NOW - 29000))
  // The live event precedes the source scan that discovers the replacement identity.
  f.receive(event('pane:leaf', NOW - 10000))
  await f.statuses({
    'pane:leaf': row('new', NOW - 10000),
    'pending:leaf': row('pending', NOW - 4 * 3600000, 'waiting')
  })
  await f.refresh()
  let agents = new Map((await f.snapshot()).agents.map((a) => [a.id, a]))
  assert.ok(
    agents
      .get(native('old'))
      .segments.filter((s) => s.state === 'working')
      .every((s) => s.end <= NOW - 10000)
  )
  assert.equal(agents.get(native('new')).segments.at(-1).end, NOW)
  assert.equal(agents.get(native('new')).segments.at(-1).state, 'working')
  f.receive(event('pending:leaf', NOW - 4 * 3600000, 'waiting'))
  await f.statuses({ 'pane:leaf': row('new', NOW + 1000, 'done') })
  context.mock.timers.setTime(NOW + 5000)
  await f.refresh()
  await f.refresh()
  agents = new Map((await f.snapshot()).agents.map((a) => [a.id, a]))
  assert.ok(
    agents
      .get(native('new'))
      .segments.filter((s) => s.state === 'working')
      .every((s) => s.end <= NOW + 1000)
  )
  assert.equal(agents.get(native('pending')).segments.at(-1).state, 'waiting')
  assert.equal(agents.get(native('pending')).segments.at(-1).end, NOW + 5000)
})
