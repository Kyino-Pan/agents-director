import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionTabClient, navigateSessionTab } from './session-tab-client.mjs'
import { createTerminalNavigator } from './terminal-navigation.mjs'
import { ActivityStore } from './activity-store.mjs'
import { defaultDataDirectory, importStatusRow } from './orca-log-reader.mjs'

let runtimeNumber = 0
async function runtime(context, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-nav-'))
  const runtimeId = `r${(++runtimeNumber).toString(36).padStart(3, '0')}-${randomUUID()}`
  const suffix = runtimeId.slice(0, 4)
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\orca-${process.pid}-${suffix}`
      : join(directory, `o-${process.pid}-${suffix}.sock`)
  const metadata = {
    pid: process.pid,
    runtimeId,
    authToken: randomUUID(),
    transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
  }
  await writeFile(join(directory, 'orca-runtime.json'), JSON.stringify(metadata), { mode: 0o600 })
  const requests = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const request = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      const authenticated = request.authToken === metadata.authToken
      requests.push({ method: request.method, params: request.params, authenticated })
      const response = handler(request)
      if (response === null) {
        socket.end()
        return
      }
      const text = `${JSON.stringify({ _keepalive: true })}\n${JSON.stringify({ id: request.id, ok: true, _meta: { runtimeId: metadata.runtimeId }, ...response })}\n`
      socket.write(text.slice(0, 23))
      socket.end(text.slice(23))
    })
  })
  await new Promise((resolve) => server.listen(endpoint, resolve))
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, requests }
}

const chat = { id: 'reopened-chat', type: 'agent-session', sessionId: 'saved-chat' }
const inventory = {
  worktree: 'folder:project',
  activeTabId: 'other',
  tabs: [{ id: 'other', type: 'agent-session', sessionId: 'other-chat' }, chat]
}

test('native Chat navigation resolves the saved conversation without a terminal and waits for host selection', async (context) => {
  let selected = false
  let visibleWorkspace = 'folder:other'
  const { directory, requests } = await runtime(context, ({ method, params }) => {
    if (method === 'terminal.reveal') {
      visibleWorkspace = params.worktreeId
      return { result: { reveal: { ...params, navigated: true } } }
    }
    if (method === 'session.tabs.activate') {
      selected =
        visibleWorkspace === inventory.worktree &&
        params.tabId === chat.id &&
        params.navigation === 'host' &&
        params.intent === 'user'
      return { result: inventory }
    }
    return { result: { ...inventory, activeTabId: selected ? chat.id : 'other' } }
  })
  const store = new ActivityStore()
  store.agent('chat', {
    sessionId: 'saved-chat',
    workspace: 'folder:project',
    paneKey: 'old-native-pane'
  })
  const navigate = createTerminalNavigator(
    store,
    [defaultDataDirectory()],
    async () => {
      throw new Error('Native Chat must not use terminal commands')
    },
    (agent) => navigateSessionTab(agent, directory)
  )
  assert.deepEqual(await navigate({ agentId: 'chat' }), { navigated: true })
  assert.ok(
    requests.every(
      (request) =>
        request.authenticated &&
        (request.method === 'terminal.reveal'
          ? request.params.worktreeId === 'folder:project'
          : request.params.worktree === 'id:folder:project')
    )
  )
  assert.equal(requests.filter((request) => request.method === 'session.tabs.activate').length, 1)
  assert.deepEqual(
    requests.slice(0, 3).map((request) => request.method),
    ['session.tabs.list', 'terminal.reveal', 'session.tabs.activate']
  )
  assert.deepEqual(requests[1].params, {
    worktreeId: 'folder:project',
    tabId: chat.id
  })
  assert.equal(requests.at(-1).method, 'session.tabs.list')
})

test('missing, ambiguous and wrong-workspace Chat records never activate another session', async (context) => {
  for (const value of [
    { ...inventory, tabs: [inventory.tabs[0]] },
    { ...inventory, tabs: [chat, { ...chat, id: 'duplicate' }] },
    { ...inventory, worktree: 'folder:other' }
  ]) {
    const { directory, requests } = await runtime(context, () => ({ result: value }))
    await assert.rejects(
      navigateSessionTab({ sessionId: 'saved-chat', workspace: 'folder:project' }, directory),
      /no longer open|identity and execution host were not recorded/
    )
    assert.deepEqual(
      requests.map((request) => request.method),
      ['session.tabs.list']
    )
  }
})

test('a Chat already selected in a background workspace still requires a desktop reveal', async (context) => {
  const { directory, requests } = await runtime(context, ({ method, params }) => {
    if (method === 'terminal.reveal') {
      return { result: { reveal: { ...params, navigated: true } } }
    }
    return { result: { ...inventory, activeTabId: chat.id } }
  })
  assert.deepEqual(
    await navigateSessionTab(
      {
        sessionId: chat.sessionId,
        workspace: inventory.worktree
      },
      directory
    ),
    { navigated: true }
  )
  assert.deepEqual(
    requests.map((request) => request.method),
    ['session.tabs.list', 'terminal.reveal', 'session.tabs.activate']
  )
})

test('a saved Chat selection cannot hide a refused, missing or misdirected desktop reveal', async (context) => {
  for (const reveal of [
    undefined,
    { navigated: false, worktreeId: inventory.worktree, tabId: chat.id },
    { navigated: true, worktreeId: 'folder:other', tabId: chat.id },
    { navigated: true, worktreeId: inventory.worktree, tabId: 'other' }
  ]) {
    const { directory, requests } = await runtime(context, ({ method }) => ({
      result: method === 'terminal.reveal' ? { reveal } : { ...inventory, activeTabId: chat.id }
    }))
    await assert.rejects(
      navigateSessionTab(
        {
          sessionId: chat.sessionId,
          workspace: inventory.worktree
        },
        directory
      ),
      /could not show this Chat workspace/
    )
    assert.deepEqual(
      requests.map((request) => request.method),
      ['session.tabs.list', 'terminal.reveal']
    )
  }
})

test('session runtime failures and replacement hosts cannot report successful navigation', async (context) => {
  for (const response of [
    null,
    { ok: false, error: { code: 'permission_denied' } },
    { id: 'other' },
    { _meta: {} },
    { _meta: { runtimeId: 'replacement' } }
  ]) {
    const { directory } = await runtime(context, () => response)
    const request = await createSessionTabClient(directory)
    await assert.rejects(request('session.tabs.list', { worktree: 'id:folder:project' }))
  }
})

const savedChat = {
  sessionId: chat.sessionId,
  workspace: inventory.worktree,
  provider: 'codex',
  resumeTarget: {
    kind: 'chat',
    sessionId: chat.sessionId,
    workspace: inventory.worktree,
    provider: 'codex',
    executionHostId: 'local',
    wslDistro: null
  }
}
const capabilities = ['agent-session.structured.v1', 'agent-session.structured.reveal.v1']
const checkDirectory = async () => ({ isDirectory: () => true })

test('closed native Chat republishes the original Orca session and then confirms desktop focus', async (context) => {
  let reopened = false
  const { directory, requests } = await runtime(context, ({ method, params }) => {
    if (method === 'status.get') return { result: { capabilities, graphStatus: 'ready' } }
    if (method === 'worktree.show')
      return {
        result: { worktree: { id: inventory.worktree, hostId: 'local', path: '/original' } }
      }
    if (method === 'agentSession.reveal') {
      reopened = true
      assert.deepEqual(params, { sessionId: chat.sessionId })
      return {
        result: {
          ok: true,
          sessionId: chat.sessionId,
          workspaceId: inventory.worktree,
          agent: 'codex'
        }
      }
    }
    if (method === 'terminal.reveal') return { result: { reveal: { ...params, navigated: true } } }
    return { result: { ...inventory, tabs: reopened ? [chat] : [], activeTabId: chat.id } }
  })
  assert.deepEqual(
    await navigateSessionTab(
      savedChat,
      directory,
      createSessionTabClient,
      () => {},
      checkDirectory
    ),
    { navigated: true }
  )
  assert.deepEqual(
    requests.map((r) => r.method),
    [
      'session.tabs.list',
      'status.get',
      'worktree.show',
      'agentSession.reveal',
      'session.tabs.list',
      'terminal.reveal',
      'session.tabs.activate'
    ]
  )
  assert.ok(requests.every((r) => r.authenticated))
})

test('closed Chat with an unsupported original host, missing workspace or missing API never reopens', async (context) => {
  for (const [patch, status, worktree, reason] of [
    [
      { executionHostId: 'ssh:original' },
      { capabilities, graphStatus: 'ready' },
      {},
      /original execution host/
    ],
    [
      { wslDistro: 'Ubuntu' },
      { capabilities, graphStatus: 'ready' },
      {},
      /original execution host/
    ],
    [{}, { capabilities: [], graphStatus: 'ready' }, {}, /does not support/],
    [
      {},
      { capabilities, graphStatus: 'ready' },
      { id: 'other', hostId: 'local' },
      /workspace is missing/
    ],
    [
      {},
      { capabilities, graphStatus: 'ready' },
      { id: inventory.worktree, hostId: 'ssh:replacement' },
      /host no longer matches/
    ]
  ]) {
    const { directory, requests } = await runtime(context, ({ method }) => ({
      result:
        method === 'status.get'
          ? status
          : method === 'worktree.show'
            ? { worktree }
            : { ...inventory, tabs: [] }
    }))
    await assert.rejects(
      navigateSessionTab(
        { ...savedChat, resumeTarget: { ...savedChat.resumeTarget, ...patch } },
        directory,
        createSessionTabClient,
        () => {},
        checkDirectory
      ),
      reason
    )
    assert.equal(
      requests.some((r) => r.method === 'agentSession.reveal'),
      false
    )
  }
})

test('a lost Chat reopen reply is not repeated and can recover through the existing Chat inventory', async () => {
  const store = new ActivityStore()
  store.agent('chat', savedChat)
  let reopened = false
  let reveals = 0
  let loseReply = true
  const request = async (method, params) => {
    if (method === 'status.get') return { capabilities, graphStatus: 'ready' }
    if (method === 'worktree.show')
      return { worktree: { id: inventory.worktree, hostId: 'local', path: '/original' } }
    if (method === 'agentSession.reveal') {
      reveals++
      if (loseReply) throw new Error('reply lost')
      reopened = true
      return {
        ok: true,
        sessionId: chat.sessionId,
        workspaceId: inventory.worktree,
        agent: 'codex'
      }
    }
    if (method === 'terminal.reveal') return { reveal: { ...params, navigated: true } }
    return { ...inventory, tabs: reopened ? [chat] : [], activeTabId: chat.id }
  }
  const navigate = createTerminalNavigator(
    store,
    [defaultDataDirectory()],
    undefined,
    undefined,
    async () => request,
    checkDirectory
  )
  await assert.rejects(navigate({ agentId: 'chat' }), /reply lost/)
  await assert.rejects(navigate({ agentId: 'chat' }), /already requested/)
  assert.equal(reveals, 1)
  reopened = true
  assert.deepEqual(await navigate({ agentId: 'chat' }), { navigated: true })
  assert.equal(reveals, 1)
  reopened = false
  loseReply = false
  assert.deepEqual(await navigate({ agentId: 'chat' }), { navigated: true })
  assert.equal(reveals, 2)
})

function chatNavigationFixture() {
  const store = new ActivityStore()
  store.agent('chat', savedChat)
  const state = { tabs: [], workspace: inventory.worktree, reveals: 0, navigated: true }
  const request = async (method, params) => {
    if (method === 'status.get') return { capabilities, graphStatus: 'ready' }
    if (method === 'worktree.show')
      return { worktree: { id: inventory.worktree, hostId: 'local', path: '/original' } }
    if (method === 'agentSession.reveal') {
      state.reveals++
      await state.reopen?.()
      state.tabs = [chat]
      return {
        ok: true,
        sessionId: chat.sessionId,
        workspaceId: inventory.worktree,
        agent: 'codex'
      }
    }
    if (method === 'terminal.reveal') return { reveal: { ...params, navigated: state.navigated } }
    return { ...inventory, worktree: state.workspace, tabs: state.tabs, activeTabId: chat.id }
  }
  const navigate = createTerminalNavigator(
    store,
    [defaultDataDirectory()],
    undefined,
    undefined,
    async () => request,
    checkDirectory
  )
  return { state, navigate: () => navigate({ agentId: 'chat' }) }
}

test('a successful native Chat reopen settles its fence before a later close and reopen', async () => {
  const f = chatNavigationFixture()
  assert.deepEqual(await f.navigate(), { navigated: true })
  f.state.tabs = []
  assert.deepEqual(await f.navigate(), { navigated: true })
  assert.equal(f.state.reveals, 2)
})

test('only the exact Chat in its workspace settles uncertainty, independently of desktop reveal', async () => {
  const f = chatNavigationFixture()
  f.state.reopen = () => {
    throw new Error('reply lost')
  }
  await assert.rejects(f.navigate(), /reply lost/)
  f.state.tabs = [{ ...chat, sessionId: 'successor' }]
  await assert.rejects(f.navigate(), /already requested/)
  f.state.tabs = [chat]
  f.state.workspace = 'folder:replacement'
  await assert.rejects(f.navigate(), /no longer open/)
  f.state.tabs = []
  f.state.workspace = inventory.worktree
  await assert.rejects(f.navigate(), /already requested/)
  assert.equal(f.state.reveals, 1)

  f.state.tabs = [chat]
  f.state.navigated = false
  await assert.rejects(f.navigate(), /could not show this Chat workspace/)
  f.state.tabs = []
  f.state.navigated = true
  f.state.reopen = undefined
  assert.deepEqual(await f.navigate(), { navigated: true })
  assert.equal(f.state.reveals, 2)
})

test('an in-flight native Chat reopen still blocks duplicate navigation', async () => {
  const f = chatNavigationFixture()
  let release
  let started
  const requested = new Promise((resolve) => {
    started = resolve
  })
  f.state.reopen = () => {
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const first = f.navigate()
  await requested
  await assert.rejects(f.navigate(), /already in progress/)
  assert.equal(f.state.reveals, 1)
  release()
  assert.deepEqual(await first, { navigated: true })
  assert.equal(f.state.reveals, 1)
})

test('resume RPC allowlist admits saved identity only and rejects commands, prompts and extra fields', async (context) => {
  const { directory, requests } = await runtime(context, () => ({ result: {} }))
  const request = await createSessionTabClient(directory)
  const valid = {
    kind: 'explicit',
    resumeOrigin: 'saved',
    worktree: 'id:folder:original',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'saved-conversation' },
    presentation: 'background'
  }
  for (const agent of ['codex', 'claude', 'devin']) {
    await request('terminal.ensureAgentSession', { ...valid, agent })
  }
  await request('agentSession.reveal', { sessionId: 'saved-chat' })
  const savedDevin = { ...valid, agent: 'devin' }
  for (const params of [
    null,
    { ...savedDevin, command: 'unsafe' },
    { ...savedDevin, prompt: 'new work' },
    { ...savedDevin, env: { SECRET: 'unsafe' } },
    { ...savedDevin, agent: 'unknown' },
    { ...valid, agent: 'cursor' },
    { ...valid, agent: 'antigravity' },
    { ...valid, agent: 'pi' },
    {
      ...valid,
      agent: 'prime-agent',
      providerSession: { ...valid.providerSession, transcriptPath: 'relative.jsonl' }
    },
    { ...savedDevin, kind: 'fresh' },
    { ...savedDevin, resumeOrigin: undefined },
    { ...savedDevin, presentation: 'foreground' },
    { ...savedDevin, worktree: 'current' },
    { ...savedDevin, worktree: 'id:folder:bad\nworkspace' },
    { ...savedDevin, providerSession: null },
    { ...savedDevin, providerSession: { ...valid.providerSession, arbitraryPath: '/arbitrary' } },
    { ...savedDevin, providerSession: { ...valid.providerSession, cwd: '/arbitrary' } },
    { ...savedDevin, providerSession: { key: 'other', id: 'saved-conversation' } },
    { ...savedDevin, providerSession: { key: 'session_id', id: '' } },
    { ...savedDevin, providerSession: { key: 'session_id', id: 123 } },
    { ...savedDevin, providerSession: { key: 'session_id', id: 'bad\nidentity' } },
    { ...savedDevin, providerSession: { key: 'session_id', id: '--last' } },
    { ...savedDevin, providerSession: { key: 'session_id', id: ' spaced ' } },
    { ...savedDevin, providerSession: { key: 'session_id', id: 'x'.repeat(513) } },
    { ...savedDevin, providerSession: { ...valid.providerSession, transcriptPath: 'bad\npath' } },
    { ...savedDevin, providerSession: { ...valid.providerSession, effort: '--unsafe' } },
    { ...savedDevin, ompResumeFilePath: '/panel/override.jsonl' }
  ])
    await assert.rejects(request('terminal.ensureAgentSession', params), /Unsupported/)
  await assert.rejects(
    request('agentSession.reveal', { sessionId: 'saved-chat', workspace: 'current' }),
    /Unsupported/
  )
  await assert.rejects(request('terminal.createAgentSession', {}), /Unsupported/)
  assert.deepEqual(
    requests.filter((r) => r.method === 'terminal.ensureAgentSession').map((r) => r.params),
    ['codex', 'claude', 'devin'].map((agent) => ({ ...valid, agent }))
  )
  assert.equal(requests.length, 4)
})

// Independent fixtures derived from native getAgentResumeArgv/RESUMABLE_TUI_AGENTS.
// Exercise collection -> persisted cache -> navigator -> real socket validator for every row.
const nativeHarnesses = [
  ...[
    'claude',
    'codebuddy',
    'codex',
    'qoder',
    'qoder-cn',
    'qwen-code',
    'gemini',
    'opencode',
    'opencode2',
    'mimo-code',
    'droid',
    'grok',
    'devin',
    'copilot',
    'kimi',
    'muse',
    'zcode',
    'dsh',
    'jcode',
    'kiro',
    'hermes'
  ].map((provider) => [
    provider,
    'session_id',
    provider === 'claude' ? { effort: 'ultrahigh' } : {}
  ]),
  ['cursor', 'conversation_id', {}],
  ['antigravity', 'conversation_id', {}],
  ['pi', 'session_id', { transcriptPath: '/saved/pi/session one.jsonl' }],
  ['prime-agent', 'session_id', { transcriptPath: '/saved/prime/session one.jsonl' }],
  ['omp', 'session_id', { transcriptPath: '/saved/omp/session one.jsonl' }]
]

async function nativeNavigation(context, provider, key, metadata = {}) {
  const now = Date.now()
  const providerSession = { key, id: 'saved:session/α ;$()', ...metadata }
  const source = new ActivityStore(now)
  importStatusRow(
    source,
    'tab:leaf',
    {
      agent: provider,
      connectionId: null,
      worktreeId: 'folder:original',
      terminalHandle: 'term_old',
      receivedAt: now,
      payload: {
        state: 'working',
        providerSession: {
          ...providerSession,
          cwd: '/original',
          command: 'do-not-copy',
          env: { SECRET: 'do-not-copy' }
        },
        launchConfig: {
          agentArgs: 'do-not-copy',
          agentEnv: { SECRET: 'do-not-copy' },
          ompResumeFilePath: '/unrelated'
        }
      }
    },
    now
  )
  const serialized = JSON.stringify(source.serialize())
  assert.equal(serialized.includes('do-not-copy'), false)
  const store = new ActivityStore(now)
  store.restore(JSON.parse(serialized), now)
  const agent = [...store.agents.values()][0]
  assert.deepEqual(agent.resumeTarget, [...source.agents.values()][0].resumeTarget)
  assert.equal(agent.resumeTarget.cwd, '/original')
  const owner = {
    type: 'terminal',
    terminal: 'term_resumed',
    parentTabId: 'tab',
    leafId: 'leaf',
    agentStatus: { agentType: provider, providerSession: { ...providerSession } }
  }
  const terminal = {
    handle: 'term_resumed',
    worktreeId: 'folder:original',
    tabId: 'tab',
    leafId: 'leaf',
    executionHostId: 'local',
    connected: true,
    verdict: 'live'
  }
  const state = {
    // A live successor in the historical pane is not the saved owner.
    tabs: [
      {
        ...owner,
        terminal: 'term_old',
        agentStatus: {
          ...owner.agentStatus,
          providerSession: { ...providerSession, id: 'successor' }
        }
      }
    ],
    terminals: [{ ...terminal, handle: 'term_old' }],
    hostScope: { hostIds: ['local'], omittedHostIds: [] },
    commands: [],
    owner,
    terminal
  }
  const mock = await runtime(context, ({ method, params }) => {
    if (method === 'session.tabs.list')
      return { result: { worktree: 'folder:original', tabs: state.tabs } }
    if (method === 'terminal.list')
      return { result: { terminals: state.terminals, hostScope: state.hostScope } }
    if (method === 'status.get')
      return {
        result: {
          graphStatus: 'ready',
          hostPlatform: 'darwin',
          capabilities: ['agent-session.host-authority.v1', 'agent-session.saved-resume-origin.v1']
        }
      }
    if (method === 'worktree.show')
      return { result: { worktree: { id: 'folder:original', hostId: 'local', path: '/original' } } }
    if (method === 'terminal.ensureAgentSession') {
      assert.deepEqual(params, {
        kind: 'explicit',
        resumeOrigin: 'saved',
        worktree: 'id:folder:original',
        agent: provider,
        providerSession,
        presentation: 'background'
      })
      if (state.resume) return state.resume(params)
      state.tabs = [structuredClone(owner)]
      state.terminals = [structuredClone(terminal)]
      return { result: { disposition: 'created', terminal } }
    }
    throw new Error(`Unexpected mock method: ${method}`)
  })
  const navigate = createTerminalNavigator(
    store,
    [defaultDataDirectory()],
    async (args) => {
      state.commands.push(args)
      if (args[0] === 'show') {
        state.onShow?.()
        return { terminal: state.terminals.find((item) => item.handle === args[2]) }
      }
      return { focus: { navigated: true } }
    },
    undefined,
    async () => createSessionTabClient(mock.directory),
    async (path) => {
      assert.equal(path, '/original')
      return { isDirectory: () => true }
    }
  )
  return {
    ...mock,
    agent,
    state,
    navigate: (input = {}) => navigate({ agentId: agent.id, ...input }),
    mutations: () =>
      mock.requests.filter((request) => request.method === 'terminal.ensureAgentSession')
  }
}

for (const [provider, key, metadata] of nativeHarnesses) {
  test(`${provider}: saved native identity survives cache and resumes through the actual client`, async (context) => {
    const f = await nativeNavigation(context, provider, key, metadata)
    assert.deepEqual(
      await f.navigate({
        workspace: 'other',
        providerSession: { key, id: 'other' },
        command: 'do-not-use'
      }),
      { navigated: true }
    )
    assert.deepEqual(f.state.commands, [
      ['show', '--terminal', 'term_resumed'],
      ['switch', '--terminal', 'term_resumed']
    ])
    // A second click finds the verified live owner, without creating another process.
    assert.deepEqual(await f.navigate(), { navigated: true })
    assert.equal(f.mutations().length, 1)
    assert.ok(f.requests.every((request) => request.authenticated))
  })
}

test('OMP also resumes by recorded ID when no transcript file was recorded', async (context) => {
  const f = await nativeNavigation(context, 'omp', 'session_id')
  assert.deepEqual(await f.navigate(), { navigated: true })
  assert.equal(f.mutations().length, 1)
})

test('native identity contracts reject missing file locators, wrong keys and unsafe recorded metadata before mutation', async (context) => {
  for (const [provider, key, metadata, patch, reason] of [
    ['pi', 'session_id', {}, {}, /no supported terminal/],
    [
      'prime-agent',
      'session_id',
      { transcriptPath: 'relative.jsonl' },
      {},
      /no supported terminal/
    ],
    ['cursor', 'session_id', {}, {}, /no supported terminal/],
    ['antigravity', 'session_id', {}, {}, /no supported terminal/],
    ['unknown', 'session_id', {}, {}, /no supported terminal/],
    ['claude', 'session_id', { effort: '--bad' }, {}, /no supported terminal/],
    ['omp', 'session_id', { transcriptPath: 'bad\nfile' }, {}, /no supported terminal/],
    [
      'kimi',
      'session_id',
      {},
      { cwd: '/another/workdir' },
      /working directory cannot be preserved/
    ],
    ['dsh', 'session_id', {}, { cwd: null }, /working directory cannot be preserved/],
    ['devin', 'session_id', {}, { executionHostId: undefined }, /original execution host/]
  ]) {
    const f = await nativeNavigation(context, provider, key, metadata)
    Object.assign(f.agent.resumeTarget, patch)
    await assert.rejects(f.navigate(), reason)
    assert.equal(f.mutations().length, 0)
    assert.equal(f.state.commands.length, 0)
  }
})

test('Pi-family file identity and a successor appearing after resume never steal navigation', async (context) => {
  for (const provider of ['pi', 'prime-agent']) {
    const f = await nativeNavigation(context, provider, 'session_id', {
      transcriptPath: '/saved/original.jsonl'
    })
    f.state.resume = () => {
      f.state.tabs = [
        {
          ...f.state.owner,
          agentStatus: {
            ...f.state.owner.agentStatus,
            providerSession: {
              ...f.state.owner.agentStatus.providerSession,
              transcriptPath: '/saved/successor.jsonl'
            }
          }
        }
      ]
      f.state.terminals = [f.state.terminal]
      return { result: { disposition: 'created', terminal: f.state.terminal } }
    }
    await assert.rejects(f.navigate(), /ownership is not confirmed/)
    await assert.rejects(f.navigate(), /already requested/)
    assert.equal(f.mutations().length, 1)
    assert.equal(f.state.commands.length, 0)
  }
  const f = await nativeNavigation(context, 'cursor', 'conversation_id')
  f.state.onShow = () => {
    f.state.tabs[0].agentStatus.providerSession.id = 'successor'
  }
  await assert.rejects(f.navigate(), /no longer belongs/)
  assert.equal(
    f.state.commands.some((args) => args[0] === 'switch'),
    false
  )
})

test('actual-client uncertain replies and disconnected native owners cannot authorize duplicate resumes', async (context) => {
  const f = await nativeNavigation(context, 'omp', 'session_id', {
    transcriptPath: '/saved/omp.jsonl'
  })
  f.state.resume = () => null // Socket closes without a receipt; no exit inference.
  const first = f.navigate()
  await assert.rejects(f.navigate(), /already in progress/)
  await assert.rejects(first, /closed the session navigation connection/)
  await assert.rejects(f.navigate(), /already requested/)
  assert.equal(f.mutations().length, 1)
  assert.equal(f.state.commands.length, 0)

  for (const verdict of ['unverifiable', 'live']) {
    const f = await nativeNavigation(context, 'pi', 'session_id', {
      transcriptPath: '/saved/pi.jsonl'
    })
    f.state.tabs = [f.state.owner]
    f.state.terminals = [{ ...f.state.terminal, connected: false, verdict }]
    await assert.rejects(f.navigate(), /disconnected or its exit is unverified/)
    assert.equal(f.mutations().length, 0)
  }
})

test('Pi-family files sharing one provider ID stay separate across collection and cache restore', () => {
  for (const provider of ['pi', 'prime-agent']) {
    const now = Date.now()
    const source = new ActivityStore(now)
    for (const [index, path] of ['/saved/first.jsonl', '/saved/second.jsonl'].entries()) {
      importStatusRow(
        source,
        'tab:leaf',
        {
          agent: provider,
          connectionId: null,
          worktreeId: 'folder:original',
          receivedAt: now + index,
          payload: { state: 'working' },
          providerSession: { key: 'session_id', id: 'shared-id', transcriptPath: path }
        },
        now + index
      )
    }
    const restored = new ActivityStore(now)
    restored.restore(JSON.parse(JSON.stringify(source.serialize())), now + 2)
    assert.equal(restored.agents.size, 2)
    assert.deepEqual(
      [...restored.agents.values()].map((agent) => agent.resumeTarget.transcriptPath),
      ['/saved/first.jsonl', '/saved/second.jsonl']
    )
  }
})

test('a post-resume inventory on a replacement execution host cannot prove ownership', async (context) => {
  const f = await nativeNavigation(context, 'antigravity', 'conversation_id')
  f.state.resume = () => {
    f.state.tabs = [f.state.owner]
    f.state.terminals = [{ ...f.state.terminal, executionHostId: 'ssh:replacement' }]
    return { result: { disposition: 'created', terminal: f.state.terminal } }
  }
  await assert.rejects(f.navigate(), /ownership is not confirmed/)
  await assert.rejects(f.navigate(), /execution host no longer matches/)
  assert.equal(f.mutations().length, 1)
  assert.equal(f.state.commands.length, 0)
})

test('actual-client ambiguous owners and omitted host inventory remain non-mutating', async (context) => {
  const ambiguous = await nativeNavigation(context, 'prime-agent', 'session_id', {
    transcriptPath: '/saved/prime.jsonl'
  })
  ambiguous.state.tabs = [
    ambiguous.state.owner,
    { ...ambiguous.state.owner, terminal: 'term_duplicate' }
  ]
  await assert.rejects(ambiguous.navigate(), /More than one terminal/)
  assert.equal(ambiguous.mutations().length, 0)
  assert.equal(ambiguous.state.commands.length, 0)

  const omitted = await nativeNavigation(context, 'cursor', 'conversation_id')
  omitted.state.hostScope = { hostIds: ['local'], omittedHostIds: ['local'] }
  await assert.rejects(omitted.navigate(), /cannot verify.*closed/)
  assert.equal(omitted.mutations().length, 0)
  assert.equal(omitted.state.commands.length, 0)
})
