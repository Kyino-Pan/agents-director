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
import { defaultDataDirectory } from './orca-log-reader.mjs'

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
      /no longer open/
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
