import { resolve } from 'node:path'
import { defaultDataDirectory } from './orca-log-reader.mjs'

const runCli = async (args) => {
  const { runTerminalCli } = await import('../dist/terminal-cli.mjs').catch(() => {
    throw new Error('Terminal navigation is unavailable in this plugin build.')
  })
  return runTerminalCli(args)
}

export function createTerminalNavigator(store, directories, command = runCli) {
  let pending = false
  return async (input) => {
    if (pending) {
      throw new Error('A terminal navigation is already in progress.')
    }
    const agent = store.agents.get(input?.agentId)
    if (!agent) {
      throw new Error('No terminal address was recorded for this agent.')
    }
    if (directories.length !== 1 || resolve(directories[0]) !== resolve(defaultDataDirectory())) {
      throw new Error('Terminal navigation is unavailable for imported data directories.')
    }
    pending = true
    try {
      let handle = agent.terminalHandle
      let terminal
      if (handle) {
        try {
          const result = await command(['show', '--terminal', handle])
          terminal = result.terminal
        } catch (error) {
          if (error.code !== 'terminal_handle_stale') {
            throw error
          }
        }
      }
      if (
        !terminal &&
        agent.workspace &&
        agent.paneKey &&
        (agent.providerSessionId || agent.sessionId) &&
        store.aliases.get(`pane:${agent.paneKey}`) === agent.id
      ) {
        const result = await command([
          'list',
          '--worktree',
          `id:${agent.workspace.replace(/^worktree:/, '')}`
        ])
        const matches = (result.terminals ?? []).filter(
          (item) =>
            `${item.tabId}:${item.leafId}` === agent.paneKey && item.connected && !item.orphaned
        )
        if (matches.length === 1) {
          terminal = matches[0]
          handle = terminal.handle
        }
      }
      if (!terminal) {
        throw new Error('No current terminal address is available for this agent.')
      }
      if (
        !terminal.connected ||
        terminal.orphaned ||
        (terminal.verdict && terminal.verdict !== 'live')
      ) {
        throw new Error('This terminal is closed or disconnected.')
      }
      const pane = `${terminal.tabId}:${terminal.leafId}`
      const owner = store.aliases.get(`pane:${agent.paneKey}`)
      if (
        (owner && owner !== agent.id) ||
        terminal.handle !== handle ||
        (agent.workspace && terminal.worktreeId !== agent.workspace.replace(/^worktree:/, '')) ||
        (agent.paneKey && pane !== agent.paneKey && terminal.recordedPaneKey !== agent.paneKey)
      ) {
        throw new Error('The terminal address no longer matches this agent.')
      }
      const { focus } = await command(['switch', '--terminal', handle])
      if (!focus?.navigated) {
        throw new Error('Orca could not show this terminal in the current desktop.')
      }
      return { navigated: true }
    } finally {
      pending = false
    }
  }
}
