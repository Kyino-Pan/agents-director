import { navigationUnavailableReason } from '../navigation-identity.mjs'

// The public agents.list result is capped at 50, without a truncation flag.
const AGENT_LIST_LIMIT = 50

export function createPublicNavigator(store, host) {
  const pending = new Map()
  const open = async (input) => {
    const agent = store.agents.get(input?.agentId)
    const reason = navigationUnavailableReason(agent)
    if (reason) throw new Error(reason)
    const { workspaces, truncated } = await host.call('workspace.list', {})
    const workspace = workspaces.find((row) => row.id === agent.workspace)
    if (!workspace) {
      throw new Error('The original workspace is no longer available in Orca.')
    }
    if ((agent.hostId ?? 'local') !== (workspace.hostId ?? 'local'))
      throw new Error('The original workspace now belongs to a different host. Open it in Orca.')
    const aliases = workspaces.filter(
      (row) =>
        workspace.path &&
        row.id !== workspace.id &&
        row.path === workspace.path &&
        (workspace.hostId == null || workspace.hostId === 'local') &&
        (row.hostId == null || row.hostId === 'local')
    )
    const { agents } = await host.call('agents.list', { workspaceId: agent.workspace })
    if (agents.length >= AGENT_LIST_LIMIT)
      throw new Error(
        'Orca could not verify the complete agent inventory. Choose this session in Orca.'
      )
    const matches = agents.filter(
      (row) => row.sessionId === agent.sessionId && row.agent === agent.provider
    )
    if (matches.length > 1)
      throw new Error('More than one terminal owns this session; choose it in Orca.')
    let terminalId = matches[0]?.terminalId
    if (matches.length && !terminalId)
      throw new Error('Orca has not provided a terminal for this live session.')
    if (terminalId && agents.filter((row) => row.terminalId === terminalId).length !== 1)
      throw new Error('The terminal has conflicting public session identities; choose it in Orca.')
    let started = false
    if (!terminalId) {
      if (aliases.length && !agent.terminalHandle)
        throw new Error(
          'Orca cannot identify the original workspace for this history-only session. Choose it in Orca.'
        )
      const { sessions } = await host.call('agent.listSessions', {
        workspaceId: agent.workspace,
        limit: 200
      })
      let available = sessions.some(
        (row) =>
          row.sessionId === agent.sessionId &&
          row.agent === agent.provider &&
          row.workspaceId === agent.workspace
      )
      // History picks one workspace when several local workspaces share a folder.
      // Only a previously observed terminal proves which workspace this lane owned.
      if (
        !available &&
        agent.terminalHandle &&
        workspace.path &&
        !truncated &&
        (workspace.hostId == null || workspace.hostId === 'local')
      ) {
        if (aliases.length) {
          const history = await host.call('agent.listSessions', { limit: 200 })
          const saved = history.sessions.filter(
            (row) => row.sessionId === agent.sessionId && row.agent === agent.provider
          )
          available =
            saved.length === 1 &&
            saved[0].hostId === 'local' &&
            aliases.some((row) => row.id === saved[0].workspaceId)
          if (available) {
            for (const alias of aliases) {
              const current = await host.call('agents.list', { workspaceId: alias.id })
              if (current.agents.length >= AGENT_LIST_LIMIT)
                throw new Error(
                  'Orca could not verify the complete agent inventory. Choose this session in Orca.'
                )
              if (
                current.agents.some(
                  (row) => row.sessionId === agent.sessionId && row.agent === agent.provider
                )
              )
                throw new Error('This session is running in another workspace; choose it in Orca.')
            }
          }
        }
      }
      if (!available) {
        throw new Error(
          'This session is not available in the public history for its original workspace.'
        )
      }
      const result = await host.call('agent.resume', {
        workspaceId: agent.workspace,
        agent: agent.provider,
        sessionId: agent.sessionId
      })
      terminalId = result.terminalId
      started = result.started
    }
    if (!terminalId) throw new Error('Orca did not return a terminal for this session.')
    const { terminals } = await host.call('terminal.list', { workspaceId: agent.workspace })
    if (terminals.filter((row) => row.id === terminalId).length !== 1)
      throw new Error('Orca did not list this terminal in its original workspace. Open it in Orca.')
    const result = await host.call('terminal.focus', { terminalId })
    return { navigated: result.focused === true, started }
  }
  return (input) => {
    const key = input?.agentId
    if (pending.has(key)) return pending.get(key)
    const result = open(input).finally(() => pending.delete(key))
    pending.set(key, result)
    return result
  }
}
