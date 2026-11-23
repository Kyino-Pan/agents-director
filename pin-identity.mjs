// Scope public IDs to their host. A recycled terminal address cannot inherit a pin:
// the fallback identifies only that recorder lane and never matches by display name.
export const projectKey = (agent) =>
  agent.projectId ? JSON.stringify([agent.hostId ?? '', agent.projectId]) : ''

export const terminalKey = (agent) =>
  JSON.stringify([
    agent.hostId ?? '',
    agent.workspace ?? '',
    agent.provider ?? '',
    agent.sessionId ? 'session' : 'lane',
    agent.sessionId || agent.id
  ])
