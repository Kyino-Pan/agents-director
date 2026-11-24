import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'
import { terminalKey } from '../pin-identity.mjs'

const NOW = Date.parse('2026-11-24T08:00:00Z')

test('a verified fresh launch resolves its creation bound through scoped public history when the global list misses it', async () => {
  for (const result of [
    'fresh',
    'empty',
    'denied',
    'older',
    'wrong-workspace',
    'attached',
    'existing'
  ]) {
    let now = NOW
    let child = result === 'existing'
    const calls = []
    const store = new ActivityStore(NOW)
    const summary = {
      sessionId: 'child',
      agent: 'codex',
      workspaceId: result === 'wrong-workspace' ? 'other' : 'w',
      createdAt: result === 'older' ? NOW - 1000 : NOW + 1000,
      updatedAt: NOW + 2000,
      title: 'Same title'
    }
    const host = {
      async call(method, params) {
        calls.push({ method, params })
        if (method === 'workspace.list')
          return { workspaces: [{ id: 'w', name: 'Workspace', hostId: 'local' }] }
        if (method === 'project.list') return { projects: [] }
        if (method === 'agents.list')
          return {
            agents: [
              {
                terminalId: 'term_parent',
                agent: 'codex',
                sessionId: 'parent',
                title: 'Same title',
                state: 'working'
              },
              ...(child
                ? [
                    {
                      terminalId: 'term_child',
                      agent: 'codex',
                      sessionId: 'child',
                      title: 'Same title',
                      state: 'working'
                    }
                  ]
                : [])
            ]
          }
        if (method === 'agent.listSessions') {
          if (params.workspaceId && result === 'denied') throw new Error('Unavailable')
          return {
            sessions:
              params.workspaceId && !['empty', 'attached', 'existing'].includes(result)
                ? [summary]
                : []
          }
        }
        throw new Error(method)
      }
    }
    const collector = new PublicCollector(store, host, () => now)
    await collector.scan()
    now += 1000
    const event = {
      terminalId: 'term_parent',
      agent: 'codex',
      tool: 'Bash',
      callId: 'launch',
      input: {
        command:
          result === 'attached'
            ? 'orca orchestration worker-start --terminal term_child --spec probe --json'
            : 'orca agent launch --agent codex --surface terminal --json'
      }
    }
    collector.relations.observe('before', event)
    collector.relations.observe('after', {
      ...event,
      output: JSON.stringify({
        ok: true,
        result:
          result === 'attached'
            ? { state: 'ready', terminal: 'term_child', dispatchId: 'ctx_new' }
            : { outcome: { kind: 'terminal', handle: 'term_child' } }
      })
    })
    child = true
    now += 1000
    await collector.scan()
    const recorded = [...store.agents.values()].find((agent) => agent.sessionId === 'child')
    assert.equal(Boolean(recorded.parentId), result === 'fresh', result)
    if (result === 'fresh') {
      assert.equal(store.agents.get(recorded.parentId).sessionId, 'parent')
      assert.equal(recorded.spawnedAt, NOW + 1000)
    }
    const scopes = () =>
      calls.filter((call) => call.method === 'agent.listSessions' && call.params.workspaceId)
    assert.equal(scopes().length, ['attached', 'existing'].includes(result) ? 0 : 1, result)
    for (let index = 0; index < 3; index++) {
      now += 5000
      await collector.scan()
    }
    assert.equal(scopes().length, ['attached', 'existing'].includes(result) ? 0 : 1, result)
    assert.ok(
      calls.every((call) => call.method !== 'agent.listSessions' || call.params.limit === 200)
    )
  }
})

test('the 160-lane budget keeps a verified spawn pair together only in its view and after pins and mail', () => {
  const store = new ActivityStore(NOW - 3600000)
  for (let index = 0; index < 160; index++) {
    const id = 'a-' + String(index).padStart(3, '0')
    store.agent(id, { label: id, sessionId: id })
    store.point(id, id, NOW - 3600000, 'working', 'live', NOW)
  }
  for (const id of ['z-parent', 'z-child']) {
    store.agent(id, { label: 'Same title', sessionId: id })
    store.point(id, id, NOW - 3600000, 'unknown', 'history', NOW - 3500000)
  }
  store.agent('z-child', { parentId: 'z-parent', spawnedAt: NOW - 600000 })
  const view = { hours: 1 / 12, end: NOW - 500000 }
  const options = { hideShortTasks: false, view }
  const ids = (options) => store.snapshot(NOW, options).agents.map((agent) => agent.id)
  const retained = ids(options)
  assert.equal(retained.length, 160)
  assert.ok(retained.includes('z-parent') && retained.includes('z-child'))
  assert.equal(ids({ ...options, view: { hours: 1 / 12, end: NOW } }).includes('z-child'), false)
  const pins = [...store.agents.values()].slice(0, 159).map(terminalKey)
  assert.equal(ids({ ...options, pinnedTerminals: pins }).includes('z-child'), false)
  assert.equal(
    ids({
      ...options,
      pinnedTerminals: [...pins.slice(0, 158), terminalKey(store.agents.get('z-parent'))]
    }).includes('z-child'),
    true
  )
  store.message({
    id: 'latest-mail',
    from: 'a-159',
    to: 'a-158',
    at: NOW - 550000,
    type: 'Send accepted'
  })
  const withMail = store.snapshot(NOW, { ...options, pinnedTerminals: pins.slice(0, 158) })
  assert.equal(withMail.messages.length, 1)
  assert.equal(
    withMail.agents.some((agent) => agent.id === 'z-child'),
    false
  )
  assert.equal(store.agents.get('z-child').parentId, 'z-parent')
})
