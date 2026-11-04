export function bindStructuredPane(store, paneKey) {
  const tab = paneKey?.split(':')[0]
  const prefix = 'structured-agent-session-'
  if (!tab?.startsWith(prefix) || tab.length === prefix.length) {
    return undefined
  }
  const sessionId = tab.slice(prefix.length)
  const id = store.agent(`session:${sessionId}`, { sessionId }, [`orca_session_id:${sessionId}`])
  const alias = `pane:${paneKey}`
  const previous = store.aliases.get(alias)
  const agent = store.agents.get(previous)
  if (previous && previous !== id && (!agent?.sessionId || agent.sessionId === sessionId)) {
    store.merge(previous, id)
  }
  store.aliases.set(alias, id)
  store.agent(id, { paneKey })
  return id
}

export class SessionRouting {
  endpoints = new Map()

  constructor(store) {
    this.store = store
    const evidence = new Map()
    for (const point of store.points.values()) {
      if (!['status-cache', 'transcript', 'journal'].includes(point.source)) {
        continue
      }
      const times = evidence.get(point.agentId) ?? []
      times.push(point.at)
      evidence.set(point.agentId, times)
    }
    for (const agent of store.agents.values()) {
      if (!agent.providerSessionId && !agent.sessionId) {
        continue
      }
      for (const address of [agent.terminalHandle, agent.paneKey && `pane:${agent.paneKey}`]) {
        if (!address) {
          continue
        }
        const owners = this.endpoints.get(address) ?? []
        owners.push({ id: agent.id, times: evidence.get(agent.id) ?? [] })
        this.endpoints.set(address, owners)
      }
    }
  }

  owner(handle, paneKey, at) {
    const owners = this.endpoints.get(paneKey && `pane:${paneKey}`) ?? this.endpoints.get(handle)
    if (!owners?.length) {
      return undefined
    }
    let latest = -Infinity
    let id
    for (const owner of owners) {
      const observed = owner.times.filter((time) => time <= at)
      const last = observed.length ? Math.max(...observed) : -Infinity
      if (last > latest) {
        latest = last
        id = owner.id
      } else if (last === latest && id !== owner.id) {
        id = undefined
      }
    }
    return id
  }

  resolve({ handle, paneKey, sessionId }, at, fallback) {
    if (sessionId) {
      return this.store.agent(`orca_session_id:${sessionId}`, { sessionId })
    }
    const owner = this.owner(handle, paneKey, at)
    if (owner) {
      return owner
    }
    const address = handle || (paneKey && `pane:${paneKey}`)
    if (this.endpoints.has(address) || this.endpoints.has(`pane:${paneKey}`)) {
      // A current address is not evidence of who owned it before the first observation.
      return this.store.agent(`unobserved:${fallback ?? address}`, {
        label: 'Unobserved agent',
        labelSource: 'fallback'
      })
    }
    return this.store.agent(fallback ?? address ?? 'unknown-address')
  }

  bind(alias, id, details) {
    const previous = this.store.aliases.get(alias)
    if (previous && previous !== id) {
      const agent = this.store.agents.get(previous)
      if (agent?.providerSessionId || agent?.sessionId) {
        if (agent.runId === details.runId) {
          delete agent.runId
        }
      } else if (previous === alias) {
        this.store.merge(previous, id)
      }
    }
    this.store.aliases.set(alias, id)
    return this.store.agent(id, details)
  }

  repairLivePoints() {
    for (const point of this.store.points.values()) {
      if (point.source !== 'live') {
        continue
      }
      const agent = this.store.agents.get(point.agentId)
      const paneKey = point.paneKey ?? agent?.paneKey
      const owner = this.owner(agent?.terminalHandle, paneKey, point.at)
      if (owner) {
        point.agentId = owner
      }
      const changes = (this.endpoints.get(`pane:${paneKey}`) ?? [])
        .filter((candidate) => candidate.id !== point.agentId)
        .flatMap((candidate) => candidate.times)
        .filter((time) => time > point.at)
      if (changes.length && Number.isFinite(point.until)) {
        point.ownershipUntil = Math.min(...changes)
        point.until = Math.min(point.until, point.ownershipUntil)
      }
    }
  }
}
