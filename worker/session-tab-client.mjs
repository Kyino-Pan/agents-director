import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export async function createSessionTabClient(directory) {
  const metadata = JSON.parse(await readFile(join(directory, 'orca-runtime.json'), 'utf8'))
  const transport = (metadata.transports ?? [metadata.transport]).find((entry) =>
    ['unix', 'named-pipe'].includes(entry?.kind)
  )
  if (!transport?.endpoint || !metadata.authToken || !metadata.runtimeId) {
    throw new Error('Orca session navigation is unavailable. Check that Orca is running.')
  }
  return (method, params) => {
    if (!['session.tabs.list', 'session.tabs.activate'].includes(method)) {
      throw new Error('Unsupported session navigation operation.')
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const socket = createConnection(transport.endpoint)
      let buffer = ''
      let settled = false
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => finish(new Error('Orca session navigation timed out.')), 8000)
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
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
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
          if (
            reply?.id !== id ||
            (reply._meta?.runtimeId && reply._meta.runtimeId !== metadata.runtimeId)
          ) {
            finish(new Error('Orca changed while resolving this session. Try again.'))
          } else if (reply.ok !== true) {
            finish(
              Object.assign(new Error('Orca could not resolve or activate this Chat.'), {
                code: reply.error?.code
              })
            )
          } else {
            finish(null, reply.result)
          }
        }
      })
    })
  }
}

export async function navigateSessionTab(agent, directory, connect = createSessionTabClient) {
  if (!agent.workspace || !agent.sessionId) {
    throw new Error('No workspace was recorded for this Chat.')
  }
  const workspace = agent.workspace.replace(/^worktree:/, '')
  const worktree = `id:${workspace}`
  const request = await connect(directory)
  const inventory = await request('session.tabs.list', { worktree })
  const matches =
    inventory?.tabs?.filter(
      (tab) => tab.type === 'agent-session' && tab.sessionId === agent.sessionId
    ) ?? []
  if (inventory?.worktree !== workspace || matches.length !== 1) {
    throw new Error('This Chat is no longer open in its recorded workspace.')
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
