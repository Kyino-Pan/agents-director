import { join } from 'node:path'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { readSourceText } from './source-files.mjs'
import { runtimeEndpoint, validateRuntimeSocket } from './runtime-endpoint.mjs'
import { prepareResume } from './session-resume.mjs'
import { validProviderSession } from './terminal-resume-policy.mjs'

const keysAre = (value, keys) =>
  value &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value)

function validateResumeRequest(method, params) {
  if (method === 'agentSession.reveal') {
    return keysAre(params, ['sessionId']) && identity(params.sessionId)
  }
  if (method === 'terminal.ensureAgentSession') {
    return (
      keysAre(params, [
        'kind',
        'resumeOrigin',
        'worktree',
        'agent',
        'providerSession',
        'presentation'
      ]) &&
      params.kind === 'explicit' &&
      params.resumeOrigin === 'saved' &&
      typeof params.worktree === 'string' &&
      params.worktree.startsWith('id:') &&
      params.worktree.length > 3 &&
      params.worktree.length <= 2051 &&
      [...params.worktree].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      ) &&
      validProviderSession(params.agent, params.providerSession) &&
      params.presentation === 'background'
    )
  }
  return true
}

export async function createSessionTabClient(directory) {
  const metadata = JSON.parse(
    await readSourceText(join(directory, 'orca-runtime.json'), [directory], 64 * 1024, {
      privateFile: true
    })
  )
  const endpoint = runtimeEndpoint(metadata, directory)
  return async (method, params) => {
    if (
      ![
        'session.tabs.list',
        'session.tabs.activate',
        'terminal.reveal',
        'diagnostics.memory',
        'terminal.list',
        'status.get',
        'worktree.show',
        'terminal.ensureAgentSession',
        'agentSession.reveal'
      ].includes(method) ||
      !validateResumeRequest(method, params)
    ) {
      throw new Error('Unsupported session navigation operation.')
    }
    await validateRuntimeSocket(endpoint, directory)
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const socket = createConnection(endpoint)
      let buffer = ''
      let receivedBytes = 0
      let settled = false
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => finish(new Error('Orca session navigation timed out.')), 12000)
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`)
      })
      socket.once('error', () =>
        finish(new Error('Could not connect to the Orca session runtime.'))
      )
      socket.once('close', () =>
        finish(new Error('Orca closed the session navigation connection.'))
      )
      socket.on('data', (chunk) => {
        buffer += chunk
        receivedBytes += Buffer.byteLength(chunk)
        if (receivedBytes > 1024 * 1024) {
          finish(new Error('Orca session inventory exceeds the navigation limit.'))
          return
        }
        let newline
        while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          let reply
          try {
            reply = JSON.parse(line)
          } catch {
            finish(new Error('Orca returned an invalid session navigation response.'))
            return
          }
          if (reply?._keepalive) continue
          if (reply?.id !== id || reply._meta?.runtimeId !== metadata.runtimeId) {
            finish(new Error('Orca changed while resolving this session. Try again.'))
          } else if (reply.ok !== true) {
            finish(
              Object.assign(
                new Error(
                  ['unknown_method', 'method_not_found'].includes(reply.error?.code)
                    ? 'This Orca runtime does not support this conversation operation. Update Orca.'
                    : 'Orca refused to resolve or open this saved conversation.'
                ),
                {
                  code: reply.error?.code
                }
              )
            )
          } else {
            finish(null, reply.result)
          }
        }
      })
    })
  }
}

export async function navigateSessionTab(
  agent,
  directory,
  connect = createSessionTabClient,
  beforeResume = () => {},
  checkDirectory,
  ownerObserved = () => {}
) {
  if (!agent.workspace || !agent.sessionId) {
    throw new Error('No workspace was recorded for this Chat.')
  }
  const workspace = agent.workspace.replace(/^worktree:/, '')
  const worktree = `id:${workspace}`
  const request = await connect(directory)
  let inventory = await request('session.tabs.list', { worktree })
  let matches =
    inventory?.tabs?.filter(
      (tab) => tab.type === 'agent-session' && tab.sessionId === agent.sessionId
    ) ?? []
  if (inventory?.worktree !== workspace || !Array.isArray(inventory.tabs) || matches.length > 1) {
    throw new Error('This Chat is no longer open in its recorded workspace.')
  }
  if (matches.length === 0) {
    await prepareResume(agent, 'chat', request, checkDirectory)
    beforeResume()
    const result = await request('agentSession.reveal', { sessionId: agent.sessionId })
    if (
      result?.ok !== true ||
      result.sessionId !== agent.sessionId ||
      result.workspaceId !== workspace ||
      result.agent !== agent.provider
    ) {
      throw new Error('Orca could not reopen the saved Chat in its original workspace.')
    }
    inventory = await request('session.tabs.list', { worktree })
    matches =
      inventory?.tabs?.filter(
        (tab) => tab.type === 'agent-session' && tab.sessionId === agent.sessionId
      ) ?? []
    if (inventory?.worktree !== workspace || matches.length !== 1) {
      throw new Error(
        'Orca did not confirm the reopened Chat. Inspect its original workspace before trying again.'
      )
    }
  }
  // An exact saved Chat in its workspace settles an earlier uncertain reopen;
  // desktop visibility is a separate confirmation and may still fail below.
  ownerObserved()
  // Tab activation alone cannot reveal an inactive Chat workspace in Orca 1.4.248.
  const { reveal } = await request('terminal.reveal', {
    worktreeId: workspace,
    tabId: matches[0].id
  })
  if (
    reveal?.navigated !== true ||
    reveal.worktreeId !== workspace ||
    reveal.tabId !== matches[0].id
  ) {
    throw new Error('Orca could not show this Chat workspace in the current desktop.')
  }
  let result = await request('session.tabs.activate', {
    worktree,
    tabId: matches[0].id,
    navigation: 'host',
    intent: 'user'
  })
  for (let attempt = 0; attempt <= 10; attempt++) {
    if (
      result?.worktree === workspace &&
      result.activeTabId === matches[0].id &&
      result.tabs?.some(
        (tab) =>
          tab.id === result.activeTabId &&
          tab.type === 'agent-session' &&
          tab.sessionId === agent.sessionId
      )
    ) {
      return { navigated: true }
    }
    if (attempt === 10) break
    await delay(100)
    result = await request('session.tabs.list', { worktree })
  }
  throw new Error('Orca did not confirm selection of this Chat.')
}
