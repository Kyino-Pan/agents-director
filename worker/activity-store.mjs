export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const STATES = new Set(['working', 'blocked', 'waiting', 'done', 'unknown'])
const MAX_RECORDS = 5000
const NAME_PRIORITY = {
  fallback: 0,
  path: 1,
  objective: 1,
  terminal: 2,
  task: 3,
  name: 3,
  conversation: 4,
  user: 5
}

const namePriority = (agent) => NAME_PRIORITY[agent.labelSource] ?? 0

export function timestamp(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string' || !value) {
    return null
  }
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export class ActivityStore {
  agents = new Map()
  projectCatalog = new Map()
  aliases = new Map()
  points = new Map()
  messages = new Map()
  sources = new Map()
  limited = false

  constructor(now = Date.now()) {
    this.collectingSince = now
    this.collectedUntil = now
  }

  agent(id, details = {}, aliases = []) {
    const keys = [id, ...aliases].filter((key) => typeof key === 'string' && key)
    const canonical = keys.map((key) => this.aliases.get(key)).find(Boolean) ?? id
    const previous = this.agents.get(canonical) ?? { id: canonical, label: canonical }
    const next = { ...previous }
    for (const [key, value] of Object.entries(details)) {
      if (key === 'label' || key === 'labelSource') {
        continue
      }
      if (key === 'spawnedAt' && Number.isFinite(previous.spawnedAt) && Number.isFinite(value)) {
        next.spawnedAt = Math.min(previous.spawnedAt, value)
      } else if (value !== undefined && value !== null && value !== '') {
        next[key] = value
      }
    }
    const label = typeof details.label === 'string' ? details.label.trim() : ''
    const labelSource = details.labelSource ?? 'name'
    if (label && (NAME_PRIORITY[labelSource] ?? 0) >= namePriority(previous)) {
      next.label = label
      next.labelSource = labelSource
    }
    next.label = String(next.label).slice(0, 160)
    this.agents.set(canonical, next)
    for (const key of keys) {
      const existing = this.aliases.get(key)
      // Historical terminal/pane addresses cannot join two different durable conversations.
      if (
        existing &&
        existing !== canonical &&
        !/^(session:|native:|child:|run:|dispatch:|orca_session_id:)/.test(key)
      ) {
        continue
      }
      if (existing && existing !== canonical && key.startsWith('pane:')) {
        continue
      }
      if (existing && existing !== canonical) {
        this.merge(existing, canonical)
      }
      this.aliases.set(key, canonical)
    }
    return canonical
  }

  merge(from, into) {
    const existing = this.agents.get(from)
    const target = this.agents.get(into)
    if (existing && target) {
      const merged = { ...existing, ...target }
      if (target.label === into || namePriority(existing) > namePriority(target)) {
        merged.label = existing.label
        merged.labelSource = existing.labelSource
      }
      this.agents.set(into, merged)
    }
    for (const [alias, id] of this.aliases) {
      if (id === from) {
        this.aliases.set(alias, into)
      }
    }
    for (const point of this.points.values()) {
      if (point.agentId === from) {
        point.agentId = into
      }
    }
    for (const message of this.messages.values()) {
      if (message.from === from) {
        message.from = into
      }
      if (message.to === from) {
        message.to = into
      }
    }
    for (const agent of this.agents.values()) {
      if (agent.parentId === from) {
        agent.parentId = into
      }
    }
    this.agents.delete(from)
  }

  point(id, agentId, at, state, source, until) {
    if (!STATES.has(state) || !Number.isFinite(at)) {
      return
    }
    const canonical = this.agent(agentId)
    this.points.set(id, {
      id,
      agentId: canonical,
      at,
      state,
      source,
      ...(Number.isFinite(until) ? { until: Math.max(at, until) } : {})
    })
  }

  message(message) {
    if (!message.id || !Number.isFinite(message.at)) {
      return
    }
    this.messages.set(message.id, {
      ...message,
      from: this.agent(message.from),
      to: this.agent(message.to),
      subject: String(message.subject ?? '').slice(0, 160),
      body:
        String(message.body ?? '').length > 400
          ? `${String(message.body).slice(0, 399)}…`
          : String(message.body ?? '')
    })
  }

  source(name, status, detail) {
    this.sources.set(name, { name, status, detail })
  }

  projectFor(agent, seen = new Set()) {
    if (!agent || seen.has(agent.id)) {
      return {}
    }
    seen.add(agent.id)
    const workspace = agent.workspace?.replace(/^worktree:/, '')
    if (workspace) {
      const repoId = workspace.includes('::') ? workspace.split('::')[0] : null
      const key = repoId ? `repo:${repoId}` : workspace
      const project = this.projectCatalog.get(key)
      if (project) {
        return project
      }
      if (repoId) {
        return { projectId: key, projectName: `Project ${repoId.slice(0, 8)}` }
      }
      return this.projectFor(this.agents.get(agent.parentId), seen)
    }
    return this.projectFor(this.agents.get(agent.parentId), seen)
  }

  prune(now = Date.now()) {
    const cutoff = now - WINDOW_MS
    const anchors = new Map()
    for (const point of this.points.values()) {
      if (point.at >= cutoff) {
        continue
      }
      const prior = anchors.get(point.agentId)
      if (
        !prior ||
        point.at > prior.at ||
        (point.at === prior.at && (point.until ?? 0) > (prior.until ?? 0))
      ) {
        anchors.set(point.agentId, point)
      }
    }
    for (const [id, point] of this.points) {
      if (point.at < cutoff && anchors.get(point.agentId) !== point) {
        this.points.delete(id)
      }
    }
    for (const anchor of anchors.values()) {
      if (anchor.until === undefined || anchor.until < cutoff) {
        this.points.delete(anchor.id)
      }
    }
    for (const [id, message] of this.messages) {
      if (message.at < cutoff) {
        this.messages.delete(id)
      }
    }
    const trim = (records) => {
      if (records.size <= MAX_RECORDS) {
        return
      }
      this.limited = true
      const ordered = [...records.values()].sort((a, b) => a.at - b.at)
      for (const item of ordered.slice(0, records.size - MAX_RECORDS)) {
        records.delete(item.id)
      }
    }
    trim(this.points)
    trim(this.messages)
    const needed = new Set([...this.points.values()].map((point) => point.agentId))
    for (const message of this.messages.values()) {
      needed.add(message.from)
      needed.add(message.to)
    }
    for (const id of needed) {
      let parent = this.agents.get(id)?.parentId
      const seen = new Set([id])
      while (parent && !seen.has(parent)) {
        seen.add(parent)
        needed.add(parent)
        parent = this.agents.get(parent)?.parentId
      }
    }
    for (const id of this.agents.keys()) {
      if (!needed.has(id)) {
        this.agents.delete(id)
      }
    }
    for (const [alias, id] of this.aliases) {
      if (!needed.has(id)) {
        this.aliases.delete(alias)
      }
    }
  }

  snapshot(now = Date.now()) {
    this.prune(now)
    const windowStart = now - WINDOW_MS
    const grouped = new Map()
    for (const point of this.points.values()) {
      if (point.at > now) {
        continue
      }
      const points = grouped.get(point.agentId) ?? []
      points.push(point)
      grouped.set(point.agentId, points)
    }
    let budget = 4000
    const agents = [...this.agents.values()]
      .filter(
        (agent) =>
          !agent.dispatchFailed ||
          agent.terminalHandle ||
          agent.paneKey ||
          agent.sessionId ||
          agent.providerSessionId ||
          (grouped.get(agent.id) ?? []).some((point) => point.source !== 'orchestration')
      )
      .map((agent) => {
        const rank = { orchestration: 0, 'status-cache': 1, transcript: 2, journal: 3, live: 4 }
        const ordered = (grouped.get(agent.id) ?? []).sort(
          (a, b) => a.at - b.at || (rank[a.source] ?? 0) - (rank[b.source] ?? 0)
        )
        const points = []
        for (const point of ordered) {
          const previous = points.at(-1)
          if (
            previous?.state === point.state &&
            (previous.at === point.at || previous.until === undefined || previous.until >= point.at)
          ) {
            points[points.length - 1] = {
              ...point,
              at: previous.at,
              source:
                (previous.until ?? Infinity) > (point.until ?? Infinity)
                  ? previous.source
                  : point.source,
              until:
                previous.until === undefined || point.until === undefined
                  ? undefined
                  : Math.max(previous.until, point.until)
            }
          } else {
            points.push(point)
          }
        }
        const segments = []
        for (let index = 0; index < points.length; index++) {
          const point = points[index]
          const next = points[index + 1]?.at ?? now
          const end = Math.min(now, next, point.until ?? next)
          const start = Math.max(windowStart, point.at)
          if (end > start) {
            segments.push({ start, end, state: point.state, source: point.source })
          }
          if (end < Math.min(next, now)) {
            segments.push({
              start: Math.max(windowStart, end),
              end: Math.min(next, now),
              state: 'unknown',
              source: 'gap'
            })
          }
        }
        if (segments.length > budget) {
          this.limited = true
        }
        const bounded = budget > 0 ? segments.slice(-budget) : []
        budget = Math.max(0, budget - bounded.length)
        return { ...agent, ...this.projectFor(agent), segments: bounded }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
    if (agents.length > 160 || this.messages.size > 600) {
      this.limited = true
    }
    const visible = agents.slice(0, 160)
    const ids = new Set(visible.map((agent) => agent.id))
    return {
      now,
      windowStart,
      agents: visible,
      messages: [...this.messages.values()]
        .filter((message) => message.at <= now && ids.has(message.from) && ids.has(message.to))
        .sort((a, b) => a.at - b.at)
        .slice(-600),
      sources: [...this.sources.values()].slice(0, 200),
      collectingSince: this.collectingSince,
      limited: this.limited
    }
  }

  serialize() {
    return {
      agents: [...this.agents.values()],
      aliases: [...this.aliases],
      points: [...this.points.values()],
      messages: [...this.messages.values()],
      collectingSince: this.collectingSince,
      collectedUntil: this.collectedUntil
    }
  }

  restore(saved, now = Date.now()) {
    if (!saved || !Array.isArray(saved.agents) || !Array.isArray(saved.points)) {
      return
    }
    this.agents = new Map(saved.agents.map((agent) => [agent.id, agent]))
    this.aliases = new Map(saved.aliases ?? [])
    this.points = new Map(saved.points.map((point) => [point.id, point]))
    this.messages = new Map((saved.messages ?? []).map((message) => [message.id, message]))
    this.collectingSince = saved.collectingSince ?? now
    this.collectedUntil = saved.collectedUntil ?? now
    // An offline recorder cannot prove that a previously working agent stayed working.
    for (const point of this.points.values()) {
      if (point.source === 'live' && point.until === undefined) {
        point.until = this.collectedUntil
      }
    }
    this.prune(now)
  }
}
