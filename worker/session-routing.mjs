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
  panes = new Map()
  observations = new Map()
  placements = new Map()

  constructor(store) {
    this.store = store
    // An agent's latest pane is navigation metadata, not its historical placement.
    for (const agent of store.agents.values()) {
      this.panes.set(agent.id, new Set(agent.paneKey ? [agent.paneKey] : []))
    }
    for (const point of store.points.values()) {
      if (point.paneKey) this.panes.get(point.agentId)?.add(point.paneKey)
      const key = `${point.agentId}:${point.at}`
      const panes = this.placements.get(key) ?? new Set()
      if (point.paneKey) panes.add(point.paneKey)
      this.placements.set(key, panes)
      if (['live', 'status-cache', 'transcript', 'journal'].includes(point.source)) {
        const points = this.observations.get(point.agentId) ?? []
        points.push(point)
        this.observations.set(point.agentId, points)
      }
    }
    for (const point of store.points.values()) {
      if (!['status-cache', 'transcript', 'journal'].includes(point.source)) {
        continue
      }
      const agent = store.agents.get(point.agentId)
      if (!agent?.providerSessionId && !agent?.sessionId) {
        continue
      }
      const paneKey = this.paneFor(point)
      const handle =
        point.terminalHandle ??
        (this.panes.get(agent.id)?.size <= 1 ? agent.terminalHandle : undefined)
      for (const address of [handle, paneKey && `pane:${paneKey}`]) {
        if (!address) {
          continue
        }
        const owners = this.endpoints.get(address) ?? []
        let owner = owners.find((candidate) => candidate.id === agent.id)
        if (!owner) {
          owner = { id: agent.id, times: [], points: [] }
          owners.push(owner)
        }
        owner.times.push(point.at)
        owner.points.push(point)
        this.endpoints.set(address, owners)
      }
    }
  }

  paneFor(point) {
    if (point.paneKey) return point.paneKey
    // v0.1.5 status points lacked placement. Recover only unambiguous evidence:
    // the matching live observation, or a conversation seen in just one pane.
    const matches = this.placements.get(`${point.agentId}:${point.at}`)
    if (matches?.size === 1) return [...matches][0]
    const panes = this.panes.get(point.agentId)
    return panes?.size === 1 ? [...panes][0] : undefined
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

  dispatchOwner(alias, { handle, paneKey, sessionId, workspace }, start, end) {
    if (sessionId) {
      return this.resolve({ sessionId }, start)
    }
    const previous = this.store.agents.get(this.store.aliases.get(alias))
    // An established assignment belongs to its conversation even after /new.
    if (previous?.providerSessionId || previous?.sessionId) {
      return previous.id
    }
    if (!Number.isFinite(start) || end < start) return undefined
    const candidates = new Set()
    const observedDuring = new Set()
    for (const address of [handle, paneKey && `pane:${paneKey}`]) {
      const owners = this.endpoints.get(address) ?? []
      const latest = Math.max(...owners.flatMap((owner) => owner.times.filter((at) => at <= start)))
      for (const owner of owners) {
        // Include ties and all observed owners during this assignment. A later
        // first observation can enrich a launch, but conflicting owners cannot.
        if (owner.times.some((at) => at === latest || (at > start && at <= end))) {
          candidates.add(owner.id)
        }
        if (owner.points.some((point) => point.at <= end && (point.until ?? point.at) >= start)) {
          observedDuring.add(owner.id)
        }
      }
    }
    if (candidates.size !== 1) return undefined
    const id = [...candidates][0]
    // Stale ownership before launch cannot claim a new assignment before its
    // first observation; otherwise a subsequent /new could never be enriched.
    if (!observedDuring.has(id)) return undefined
    const agent = this.store.agents.get(id)
    if (
      (handle && agent.terminalHandle && handle !== agent.terminalHandle) ||
      (paneKey && agent.paneKey && paneKey !== agent.paneKey) ||
      (workspace &&
        agent.workspace &&
        workspace.replace(/^worktree:/, '') !== agent.workspace.replace(/^worktree:/, ''))
    )
      return undefined
    return id
  }

  bind(alias, id, details) {
    const previous = this.store.aliases.get(alias)
    if (previous && previous !== id) {
      const agent = this.store.agents.get(previous)
      if (agent?.providerSessionId || agent?.sessionId) {
        if (agent.runId === details.runId) {
          delete agent.runId
        }
      } else {
        this.store.merge(previous, id)
      }
    }
    this.store.aliases.set(alias, id)
    return this.store.agent(id, details)
  }

  repairLivePoints() {
    for (const point of this.store.points.values()) {
      if (!['live', 'status-cache'].includes(point.source)) {
        continue
      }
      const agent = this.store.agents.get(point.agentId)
      const paneKey = this.paneFor(point)
      const owner = this.owner(point.terminalHandle, paneKey, point.at)
      if (owner && point.source === 'live') {
        point.agentId = owner
      }
      const changes = (this.endpoints.get(`pane:${paneKey}`) ?? [])
        .filter((candidate) => candidate.id !== point.agentId)
        .flatMap((candidate) => candidate.times)
        .filter((time) => time > point.at)
      const workspace = (point.workspace ?? agent?.workspace)?.replace(/^worktree:/, '')
      const closedAt = this.store.terminalClosures.get(`${workspace}:${paneKey?.split(':')[0]}`)
      if (Number.isFinite(closedAt) && closedAt >= point.at) changes.push(closedAt)
      if (point.source === 'live') {
        for (const candidate of this.observations.get(point.agentId) ?? []) {
          if (candidate.at > point.at && candidate.state !== point.state) changes.push(candidate.at)
        }
      }
      if (changes.length) {
        point.ownershipUntil = Math.min(point.ownershipUntil ?? Infinity, ...changes)
        point.until = Math.min(point.until ?? Infinity, point.ownershipUntil)
      }
    }
  }
}
