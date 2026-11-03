import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityStore } from './activity-store.mjs'
import { defaultDataDirectory } from './orca-log-reader.mjs'
import { createTerminalNavigator } from './terminal-navigation.mjs'

const agent = { terminalHandle: 'term_one', workspace: 'folder:notes', paneKey: 'tab:leaf' }
const terminal = {
  handle: 'term_one',
  worktreeId: 'folder:notes',
  tabId: 'tab',
  leafId: 'leaf',
  connected: true
}

test('navigation validates the recorded identity before switching and forwards only its stored handle', async () => {
  const store = new ActivityStore()
  store.agent('agent', agent)
  const calls = []
  const navigate = createTerminalNavigator(store, [defaultDataDirectory()], async (args) => {
    calls.push(args)
    return args[0] === 'show' ? { terminal } : { focus: { navigated: true } }
  })
  assert.deepEqual(await navigate({ agentId: 'agent', terminalHandle: 'term_other' }), {
    navigated: true
  })
  assert.deepEqual(calls, [
    ['show', '--terminal', 'term_one'],
    ['switch', '--terminal', 'term_one']
  ])
})

test('closed, reused, imported and unknown terminal addresses never navigate', async () => {
  for (const [record, directories, input, message] of [
    [
      { ...terminal, verdict: 'unverifiable' },
      [defaultDataDirectory()],
      'agent',
      /closed or disconnected/
    ],
    [
      { ...terminal, connected: false },
      [defaultDataDirectory()],
      'agent',
      /closed or disconnected/
    ],
    [{ ...terminal, orphaned: true }, [defaultDataDirectory()], 'agent', /closed or disconnected/],
    [{ ...terminal, leafId: 'reused' }, [defaultDataDirectory()], 'agent', /no longer matches/],
    [{ ...terminal, worktreeId: 'other' }, [defaultDataDirectory()], 'agent', /no longer matches/],
    [terminal, ['/imported/host'], 'agent', /imported data/],
    [terminal, [defaultDataDirectory()], 'unknown', /No terminal address/]
  ]) {
    const store = new ActivityStore()
    store.agent('agent', agent)
    const calls = []
    const navigate = createTerminalNavigator(store, directories, async (args) => {
      calls.push(args[0])
      return { terminal: record }
    })
    await assert.rejects(navigate({ agentId: input }), message)
    assert.ok(!calls.includes('switch'))
  }
})

test('navigation reports an unconfirmed switch and permits retry after failure', async () => {
  const store = new ActivityStore()
  store.agent('agent', agent)
  let navigated = false
  const navigate = createTerminalNavigator(store, [defaultDataDirectory()], async ([action]) =>
    action === 'show' ? { terminal } : { focus: { navigated } }
  )
  await assert.rejects(navigate({ agentId: 'agent' }), /could not show/)
  navigated = true
  assert.deepEqual(await navigate({ agentId: 'agent' }), { navigated: true })
})

test('a restarted terminal is recovered only for the conversation that still owns its pane', async () => {
  for (const current of [true, false]) {
    const store = new ActivityStore()
    store.agent('agent', { ...agent, providerSessionId: 'conversation' })
    store.aliases.set('pane:tab:leaf', current ? 'agent' : 'successor')
    const calls = []
    const navigate = createTerminalNavigator(store, [defaultDataDirectory()], async (args) => {
      calls.push(args)
      if (args[0] === 'show') {
        throw Object.assign(new Error('Expired'), { code: 'terminal_handle_stale' })
      }
      if (args[0] === 'list') {
        return { terminals: [{ ...terminal, handle: 'term_new' }] }
      }
      return { focus: { navigated: true } }
    })
    if (current) {
      await navigate({ agentId: 'agent' })
      assert.deepEqual(calls.at(-1), ['switch', '--terminal', 'term_new'])
    } else {
      await assert.rejects(navigate({ agentId: 'agent' }), /No current terminal/)
      assert.equal(calls.length, 1)
    }
  }
})

test('repeated activation while resolving a terminal does not switch twice', async () => {
  const store = new ActivityStore()
  store.agent('agent', agent)
  let release
  const lookup = new Promise((resolve) => {
    release = resolve
  })
  let switches = 0
  const navigate = createTerminalNavigator(store, [defaultDataDirectory()], async ([action]) => {
    if (action === 'show') {
      return lookup
    }
    switches++
    return { focus: { navigated: true } }
  })
  const first = navigate({ agentId: 'agent' })
  await assert.rejects(navigate({ agentId: 'agent' }), /already in progress/)
  release({ terminal })
  await first
  assert.equal(switches, 1)
})
