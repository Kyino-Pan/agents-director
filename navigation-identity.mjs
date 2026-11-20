export function navigationUnavailableReason(agent) {
  if (!agent?.workspace) return 'Cannot open this agent because its original workspace is unknown.'
  if (!agent.provider) return 'Cannot open this agent because its provider is unknown.'
  if (!agent.sessionId) {
    return agent.parentId
      ? 'This subagent has no public session ID. Open its parent conversation.'
      : 'Orca has not provided a public session ID for this agent.'
  }
  return ''
}
