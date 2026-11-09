import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityStore } from './activity-store.mjs'
import { defaultDataDirectory, importStatusRow } from './orca-log-reader.mjs'
import { createTerminalNavigator } from './terminal-navigation.mjs'

const agent = {
  terminalHandle: 'term_one',
  workspace: 'folder:notes',
  paneKey: 'tab:leaf',
  provider: 'codex',
  providerSessionId: 'conversation',
  resumeTarget: {
    kind: 'terminal',
    workspace: 'folder:notes',
    provider: 'codex',
    providerSessionKey: 'session_id',
    providerSessionId: 'conversation',
    executionHostId: 'local',
    wslDistro: null
  }
}
const terminal = {
  handle: 'term_one',
  worktreeId: agent.workspace,
  tabId: 'tab',
  leafId: 'leaf',
  executionHostId: 'local',
  connected: true,
  verdict: 'live'
}
const tab = {
  type: 'terminal',
  terminal: terminal.handle,
  parentTabId: 'tab',
  leafId: 'leaf',
  agentStatus: { agentType: 'codex', providerSession: { key: 'session_id', id: 'conversation' } }
}
function fixture(options = {}) {
  const store = new ActivityStore()
  store.agent('agent', structuredClone(agent))
  // Deliberately retain stale historical aliases; live ownership must win.
  store.aliases.set('pane:tab:leaf', 'agent')
  const state = {
    tabs: [structuredClone(tab)],
    terminals: [structuredClone(terminal)],
    hostScope: { hostIds: ['local'], omittedHostIds: [] },
    worktree: { id: agent.workspace, hostId: 'local', path: '/original/workspace' },
    capabilities: ['agent-session.host-authority.v1', 'agent-session.saved-resume-origin.v1'],
    ...options
  }
  const calls = []
  const command = async (args) => {
    calls.push({ command: args })
    if (args[0] === 'show') {
      options.onShow?.(state)
      return { terminal: state.terminals.find((t) => t.handle === args[2]) }
    }
    return { focus: { navigated: state.navigated !== false } }
  }
  const request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'session.tabs.list') return { worktree: agent.workspace, tabs: state.tabs }
    if (method === 'terminal.list')
      return { terminals: state.terminals, hostScope: state.hostScope, truncated: state.truncated }
    if (method === 'status.get')
      return {
        capabilities: state.capabilities,
        graphStatus: state.graphStatus ?? 'ready',
        hostPlatform: state.hostPlatform ?? 'darwin'
      }
    if (method === 'worktree.show') return { worktree: state.worktree }
    if (method === 'terminal.ensureAgentSession') {
      if (state.resume) return state.resume(state, params)
      state.tabs = [{ ...tab, terminal: 'term_resumed' }]
      state.terminals = [{ ...terminal, handle: 'term_resumed' }]
      return { disposition: 'created', terminal: state.terminals[0] }
    }
    throw new Error(`Unexpected method ${method}`)
  }
  const navigate = createTerminalNavigator(
    store,
    options.directories ?? [defaultDataDirectory()],
    command,
    undefined,
    async () => request,
    async (path) => {
      assert.equal(path, '/original/workspace')
      if (state.deleted) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { isDirectory: () => true }
    }
  )
  return { store, state, calls, navigate }
}
const mutations = (f) => f.calls.filter((c) => c.method === 'terminal.ensureAgentSession')
const switches = (f) => f.calls.filter((c) => c.command?.[0] === 'switch')

test('existing owner is preferred and panel-provided target fields are ignored', async () => {
  const f = fixture()
  assert.deepEqual(
    await f.navigate({ agentId: 'agent', terminalHandle: 'term_other', workspace: 'other' }),
    { navigated: true }
  )
  assert.deepEqual(switches(f), [{ command: ['switch', '--terminal', 'term_one'] }])
  assert.equal(mutations(f).length, 0)
})

test('live conversation can move to another pane and handle without trusting historical aliases', async () => {
  const f = fixture()
  f.state.tabs = [{ ...tab, parentTabId: 'new', leafId: 'pane', terminal: 'term_new' }]
  f.state.terminals = [{ ...terminal, tabId: 'new', leafId: 'pane', handle: 'term_new' }]
  assert.deepEqual(await f.navigate({ agentId: 'agent' }), { navigated: true })
  assert.deepEqual(switches(f)[0].command, ['switch', '--terminal', 'term_new'])
  assert.equal(mutations(f).length, 0)
})

test('closed session resumes only its saved identity in its original workspace', async () => {
  const f = fixture({ tabs: [], terminals: [] })
  await f.navigate({ agentId: 'agent' })
  assert.deepEqual(mutations(f)[0].params, {
    kind: 'explicit',
    resumeOrigin: 'saved',
    worktree: 'id:folder:notes',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conversation' },
    presentation: 'background'
  })
  assert.deepEqual(switches(f)[0].command, ['switch', '--terminal', 'term_resumed'])
  await f.navigate({ agentId: 'agent' })
  assert.equal(mutations(f).length, 1)
})

test('a successful verified resume settles its fence before a later close and resume', async () => {
  const f = fixture({ tabs: [], terminals: [] })
  assert.deepEqual(await f.navigate({ agentId: 'agent' }), { navigated: true })
  f.state.tabs = []
  f.state.terminals = []
  assert.deepEqual(await f.navigate({ agentId: 'agent' }), { navigated: true })
  assert.equal(mutations(f).length, 2)
})

test('a reused historical pane never navigates to its successor, and resumes into a new terminal', async () => {
  const f = fixture()
  f.state.tabs[0].agentStatus.providerSession.id = 'successor'
  await f.navigate({ agentId: 'agent' })
  assert.deepEqual(switches(f)[0].command, ['switch', '--terminal', 'term_resumed'])
  assert.equal(mutations(f).length, 1)
})

test('ownership changing between lookup and switch is refused', async () => {
  const f = fixture({
    onShow: (state) => {
      state.tabs[0].agentStatus.providerSession.id = 'successor'
    }
  })
  await assert.rejects(f.navigate({ agentId: 'agent' }), /no longer belongs/)
  assert.equal(switches(f).length, 0)
  assert.equal(mutations(f).length, 0)
})

test('disconnected or unverified live owner never becomes a resume request', async () => {
  for (const change of [{ verdict: 'unverifiable' }, { connected: false }, { orphaned: true }]) {
    const f = fixture({ terminals: [{ ...terminal, ...change }] })
    await assert.rejects(f.navigate({ agentId: 'agent' }), /disconnected or its exit is unverified/)
    assert.equal(mutations(f).length, 0)
    assert.equal(switches(f).length, 0)
  }
})

test('missing identity, internal child, imported source, removed workspace and unsupported host never launch', async () => {
  const cases = [
    [{ resumeTarget: undefined }, {}, /not recorded/],
    [{ resumeTarget: undefined, parentId: 'parent' }, {}, /internal subagent/],
    [{ providerSessionId: undefined }, {}, /No provider conversation/],
    [
      { resumeTarget: { ...agent.resumeTarget, executionHostId: 'ssh:original' } },
      {},
      /original execution host/
    ],
    [
      { resumeTarget: { ...agent.resumeTarget, wslDistro: 'Ubuntu' } },
      {},
      /original execution host/
    ],
    [{}, { worktree: undefined }, /original workspace is missing/],
    [{}, { worktree: { id: agent.workspace, hostId: 'ssh:replacement' } }, /no longer matches/],
    [{}, { deleted: true }, /directory is no longer available/],
    [{}, { capabilities: [] }, /does not support/],
    [{}, { graphStatus: 'reloading' }, /not ready/],
    [{}, { hostPlatform: 'win32' }, /Windows or WSL/],
    [{}, { directories: ['/imported'] }, /imported data/],
    [{}, { hostScope: undefined }, /verify.*closed/],
    [{}, { truncated: true }, /current conversation inventory/]
  ]
  for (const [patch, options, reason] of cases) {
    const f = fixture({ tabs: [], terminals: [], ...options })
    Object.assign(f.store.agents.get('agent'), patch)
    await assert.rejects(f.navigate({ agentId: 'agent' }), reason)
    assert.equal(mutations(f).length, 0)
    assert.equal(switches(f).length, 0)
  }
})

test('unidentified reused pane and ambiguous current owners cannot justify a resume', async () => {
  for (const tabs of [
    { ...tab, agentStatus: undefined },
    [tab, { ...tab, terminal: 'term_two' }]
  ]) {
    const f = fixture({ tabs: Array.isArray(tabs) ? tabs : [tabs] })
    await assert.rejects(f.navigate({ agentId: 'agent' }), /verify.*closed|More than one/)
    assert.equal(mutations(f).length, 0)
  }
})

test('in-flight duplicate activation and uncertain retry never issue a second resume', async () => {
  let release
  const reply = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture({
    tabs: [],
    terminals: [],
    resume: async () => {
      await reply
      throw new Error('timeout')
    }
  })
  const first = f.navigate({ agentId: 'agent' })
  await assert.rejects(f.navigate({ agentId: 'agent' }), /already in progress/)
  release()
  await assert.rejects(first, /timeout/)
  await assert.rejects(f.navigate({ agentId: 'agent' }), /already requested/)
  assert.equal(mutations(f).length, 1)
  assert.equal(switches(f).length, 0)
})

test('uncertain resume can recover by navigating a verified owner without relaunching', async () => {
  const f = fixture({
    tabs: [],
    terminals: [],
    resume: async (state) => {
      state.tabs = [tab]
      state.terminals = [terminal]
      throw new Error('reply lost')
    }
  })
  await assert.rejects(f.navigate({ agentId: 'agent' }), /reply lost/)
  assert.deepEqual(await f.navigate({ agentId: 'agent' }), { navigated: true })
  assert.equal(mutations(f).length, 1)
  f.state.tabs = []
  f.state.terminals = []
  f.state.resume = undefined
  assert.deepEqual(await f.navigate({ agentId: 'agent' }), { navigated: true })
  assert.equal(mutations(f).length, 2)
})

test('only the exact live owner settles uncertainty, independently of desktop focus', async () => {
  const f = fixture({
    tabs: [],
    terminals: [],
    resume: () => {
      throw new Error('reply lost')
    }
  })
  await assert.rejects(f.navigate({ agentId: 'agent' }), /reply lost/)
  f.state.tabs = [
    {
      ...tab,
      agentStatus: { ...tab.agentStatus, providerSession: { key: 'session_id', id: 'successor' } }
    }
  ]
  f.state.terminals = [terminal]
  await assert.rejects(f.navigate({ agentId: 'agent' }), /already requested/)
  f.state.tabs = [tab]
  f.state.terminals = [{ ...terminal, executionHostId: 'ssh:replacement' }]
  await assert.rejects(f.navigate({ agentId: 'agent' }), /execution host no longer matches/)
  f.state.tabs = []
  f.state.terminals = []
  await assert.rejects(f.navigate({ agentId: 'agent' }), /already requested/)
  assert.equal(mutations(f).length, 1)

  f.state.tabs = [tab]
  f.state.terminals = [terminal]
  f.state.navigated = false
  await assert.rejects(f.navigate({ agentId: 'agent' }), /could not show/)
  f.state.tabs = []
  f.state.terminals = []
  f.state.navigated = true
  f.state.resume = undefined
  assert.deepEqual(await f.navigate({ agentId: 'agent' }), { navigated: true })
  assert.equal(mutations(f).length, 2)
})

test('unconfirmed switch is retryable without resuming', async () => {
  const f = fixture({ navigated: false })
  await assert.rejects(f.navigate({ agentId: 'agent' }), /could not show/)
  f.state.navigated = true
  await f.navigate({ agentId: 'agent' })
  assert.equal(mutations(f).length, 0)
})

test('status import retains resume identity and explicit host provenance, never launch env or commands', () => {
  for (const connectionId of [null, 'remote', undefined]) {
    const store = new ActivityStore()
    importStatusRow(
      store,
      'tab:leaf',
      {
        connectionId,
        worktreeId: 'folder:notes',
        terminalHandle: 'term_one',
        providerSession: { key: 'session_id', id: 'conversation' },
        agent: 'codex',
        receivedAt: Date.now(),
        payload: { agentEnv: { SECRET: 'must-not-copy' }, command: 'unsafe' }
      },
      Date.now()
    )
    const target = [...store.agents.values()][0].resumeTarget
    assert.equal(
      target.executionHostId,
      connectionId === null ? 'local' : connectionId ? 'ssh:remote' : undefined
    )
    assert.equal(target.providerSessionId, 'conversation')
    assert.equal(JSON.stringify(target).includes('SECRET'), false)
    assert.equal(JSON.stringify(target).includes('command'), false)
  }
})

test('current terminal on a replacement host never navigates or resumes', async () => {
  const f = fixture({ terminals: [{ ...terminal, executionHostId: 'ssh:replacement' }] })
  await assert.rejects(f.navigate({ agentId: 'agent' }), /execution host no longer matches/)
  assert.equal(switches(f).length, 0)
  assert.equal(mutations(f).length, 0)
})

test('a confirmed exited owner can resume, but an uncertain receipt cannot report success or retry', async () => {
  const f = fixture({ terminals: [{ ...terminal, connected: false, verdict: 'exited' }] })
  await f.navigate({ agentId: 'agent' })
  assert.equal(mutations(f).length, 1)
  for (const receipt of [
    { disposition: 'created', terminal: { ...terminal, worktreeId: 'other' } },
    { disposition: 'created', terminal: { ...terminal, executionHostId: 'ssh:other' } },
    { disposition: 'created', terminal }
  ]) {
    const f = fixture({ tabs: [], terminals: [], resume: () => receipt })
    await assert.rejects(
      f.navigate({ agentId: 'agent' }),
      /did not confirm|ownership is not confirmed/
    )
    await assert.rejects(f.navigate({ agentId: 'agent' }), /already requested/)
    assert.equal(mutations(f).length, 1)
    assert.equal(switches(f).length, 0)
  }
})
