export function createPublicNavigator(store, host) {
  const pending = new Map()
  const open = async (input) => {
    const agent = store.agents.get(input?.agentId)
    if (!agent?.workspace || !agent.sessionId || !agent.provider) {
      throw new Error(
        'No public session identity and original workspace are available for this agent.'
      )
    }
    const { workspaces } = await host.call('workspace.list', {})
    if (!workspaces.some((row) => row.id === agent.workspace)) {
      throw new Error('The original workspace is no longer available in Orca.')
    }
    const { agents } = await host.call('agents.list', { workspaceId: agent.workspace })
    const matches = agents.filter(
      (row) => row.sessionId === agent.sessionId && row.agent === agent.provider
    )
    if (matches.length > 1)
      throw new Error('More than one terminal owns this session; choose it in Orca.')
    let terminalId = matches[0]?.terminalId
    let started = false
    if (!terminalId) {
      const { sessions } = await host.call('agent.listSessions', {
        workspaceId: agent.workspace,
        limit: 200
      })
      if (
        !sessions.some(
          (row) =>
            row.sessionId === agent.sessionId &&
            row.agent === agent.provider &&
            row.workspaceId === agent.workspace
        )
      ) {
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
