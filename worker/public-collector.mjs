import { RouteEvidence } from './route-evidence.mjs'
import { WINDOW_MS } from './activity-store.mjs'

const STATES = new Set(['working', 'blocked', 'waiting', 'done'])
const MAX_GAP_MS = 15_000
const HISTORY_INTERVAL_MS = 30_000
const text = (value) => (typeof value === 'string' && value ? value : null)
const address = (workspace, terminal) => JSON.stringify([workspace, terminal])
const sessionKey = (workspace, provider, session) =>
  `public:${JSON.stringify([workspace, provider, session])}`

// Only documented host API results supply identities, routes and observations.
export class PublicCollector {
  workspaces = new Map()
  live = new Map()
  revisions = new Map()
  identities = new Map()
  historyAt = -Infinity
  launchHistoryAt = new Map()
  sequence = 0

  constructor(store, host, now = Date.now) {
    this.store = store
    this.host = host
    this.now = now
    this.relations = new RouteEvidence(store, (terminal) => this.owner(terminal), now)
    this.boot = `${now()}:${Math.random().toString(36).slice(2)}`
    store.source(
      'Coverage',
      'limited',
      'Public session summaries, terminal states and verified local tool receipts. Messages without observable endpoints and past coordination are unavailable.'
    )
  }

  identify(workspace, row) {
    const session = text(row.sessionId)
    const provider = text(row.agent)
    const terminal = text(row.terminalId)
    if (!session && !terminal) return null
    const route = address(workspace.id, terminal)
    const previous = this.live.get(route)
    const id = session
      ? sessionKey(workspace.id, provider, session)
      : previous &&
          !this.store.agents.get(previous.agentId)?.sessionId &&
          previous.provider === provider
        ? previous.agentId
        : `public-terminal:${this.boot}:${++this.sequence}`
    return this.store.agent(id, {
      workspace: workspace.id,
      workspaceName: workspace.name,
      hostId: workspace.hostId,
      projectId: workspace.projectId || workspace.id,
      projectName: workspace.project || workspace.name,
      provider,
      sessionId: session,
      terminalHandle: terminal,
      label: row.task?.title || row.title || `${provider || 'Agent'} session`,
      labelSource: row.task?.title ? 'task' : row.title ? 'conversation' : 'fallback'
    })
  }

  owner(terminal) {
    let owner
    for (const row of this.live.values()) {
      if (row.owner?.terminal !== terminal || this.now() - row.at > MAX_GAP_MS) continue
      if (owner) return
      owner = row.owner
    }
    return owner
  }

  identity(route, session, at) {
    const prior = this.identities.get(route)
    if (prior?.session === session) return prior
    const identity = { session, since: at, first: !prior }
    this.identities.set(route, identity)
    return identity
  }

  observe(workspace, row, at) {
    if (!STATES.has(row.state)) return
    const id = this.identify(workspace, row)
    if (!id || !row.terminalId) return
    const route = address(workspace.id, row.terminalId)
    const stateStartedAt = Number.isFinite(row.stateStartedAt) ? row.stateStartedAt : null
    const previous = this.live.get(route)
    if (previous && at < previous.at) return
    if (previous && previous.agentId !== id) {
      this.store.breakWorkingRun(previous.agentId, at)
      this.store.breakWorkingRun(id, at)
    }
    const session = text(row.sessionId)
    const identity = session && this.identity(route, session, at)
    const owner =
      identity &&
      row.agent &&
      (previous?.owner?.identity === identity &&
      previous.agentId === id &&
      at - previous.at <= MAX_GAP_MS
        ? previous.owner
        : {
            identity,
            id,
            terminal: row.terminalId,
            provider: row.agent,
            first: identity.first,
            since: identity.since
          })
    const point =
      previous &&
      (this.store.points.get(previous.key) ??
        this.store.workingRunAt(previous.agentId, previous.at))
    if (
      point &&
      previous.agentId === id &&
      previous.owner === owner &&
      point.state === row.state &&
      previous.state === row.state &&
      previous.stateStartedAt === stateStartedAt &&
      at - previous.at <= MAX_GAP_MS
    ) {
      point.until = at
      previous.key = point.id
      previous.at = at
      return
    }
    // Do not bridge missing polls, closed terminals, recycled addresses or offline gaps.
    const key = `public-live:${this.boot}:${++this.sequence}`
    this.store.point(key, id, at, row.state, 'live', at)
    this.live.set(route, {
      key,
      agentId: id,
      owner,
      provider: text(row.agent),
      state: row.state,
      stateStartedAt,
      at
    })
  }

  receive(event) {
    // workspaceId on older events is an internal address. Never manufacture a public route.
    const workspace = this.workspaces.get(event.workspaceListId || event.workspaceId)
    if (!workspace || !event.terminalId) return
    const route = address(workspace.id, event.terminalId)
    const previous = this.live.get(route)
    const at = Math.min(
      this.now(),
      Number.isFinite(event.receivedAt) ? event.receivedAt : this.now()
    )
    if (previous && at < previous.at) return
    this.revisions.set(route, (this.revisions.get(route) || 0) + 1)
    const session = text(event.sessionId)
    if (previous && (!session || this.store.agents.get(previous.agentId)?.sessionId !== session))
      this.store.breakWorkingRun(previous.agentId, at)
    if (session) this.identity(route, session, at)
    const candidates = [...this.store.agents.values()].filter(
      (agent) => agent.workspace === workspace.id && session && agent.sessionId === session
    )
    // Events do not include the provider. An unknown identity is resolved by the next list call.
    if (candidates.length !== 1) {
      this.live.delete(route)
      return
    }
    const agent = candidates[0]
    this.observe(
      workspace,
      {
        agent: agent.provider,
        sessionId: session,
        terminalId: event.terminalId,
        title: event.title || agent.label,
        state: event.mainAgent?.state || event.state,
        stateStartedAt: event.mainAgent?.stateStartedAt
      },
      at
    )
  }

  async scan() {
    const { store, host } = this
    let rows
    try {
      const result = await host.call('workspace.list', { includeStatus: true })
      rows = result.workspaces
      if (!Array.isArray(rows)) throw new Error('Invalid workspace list')
      this.workspaces = new Map(rows.map((row) => [row.id, row]))
      store.source(
        'Workspaces',
        result.truncated ? 'limited' : 'ok',
        result.truncated
          ? 'Workspace list truncated; unlisted workspaces are unknown.'
          : 'Workspaces read through the public API.'
      )
    } catch (error) {
      this.live.clear()
      store.source('Workspaces', 'error', error.message)
      return
    }
    try {
      const result = await host.call('project.list', {})
      const projects = new Map(
        result.projects.map((row) => [JSON.stringify([row.hostId, row.id]), row])
      )
      for (const workspace of rows) {
        workspace.project =
          projects.get(JSON.stringify([workspace.hostId, workspace.projectId]))?.name ||
          workspace.project
      }
      store.source(
        'Projects',
        result.truncated ? 'limited' : 'ok',
        'Project names read through the public API.'
      )
    } catch (error) {
      store.source('Projects', 'error', error.message)
    }
    for (const route of this.live.keys()) {
      if (!this.workspaces.has(JSON.parse(route)[0])) this.live.delete(route)
    }
    // Bound concurrency to avoid flooding the host in large multi-project installations.
    let index = 0
    const scanWorkspace = async () => {
      while (index < rows.length) {
        const workspace = rows[index++]
        const revisions = new Map(this.revisions)
        try {
          const result = await host.call('agents.list', { workspaceId: workspace.id })
          if (!Array.isArray(result.agents)) throw new Error('Invalid agent list')
          const at = this.now()
          const present = new Set()
          const unique = new Set()
          const ambiguous = new Set()
          for (const { terminalId } of result.agents) {
            if (unique.has(terminalId)) ambiguous.add(terminalId)
            unique.add(terminalId)
          }
          for (const row of result.agents) {
            const route = address(workspace.id, row.terminalId)
            if (ambiguous.has(row.terminalId)) continue
            present.add(route)
            if ((this.revisions.get(route) || 0) === (revisions.get(route) || 0)) {
              this.observe(workspace, row, at)
            }
          }
          for (const route of this.live.keys()) {
            if (
              JSON.parse(route)[0] === workspace.id &&
              !present.has(route) &&
              (this.revisions.get(route) || 0) === (revisions.get(route) || 0)
            )
              this.live.delete(route)
          }
          store.source(
            `Agents · ${workspace.id}`,
            'ok',
            `${workspace.name}: current agents read through the public API.`
          )
        } catch (error) {
          for (const route of this.live.keys()) {
            if (JSON.parse(route)[0] === workspace.id) this.live.delete(route)
          }
          store.source(`Agents · ${workspace.id}`, 'error', `${workspace.name}: ${error.message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(rows.length, 4) }, scanWorkspace))
    if (this.now() - this.historyAt >= HISTORY_INTERVAL_MS) await this.history()
    this.relations.refresh()
    // A fresh terminal can precede the host's unscoped history cache, or fall
    // outside its newest 200 rows. Ask only the proven launch's workspace for
    // the missing creation bound; never replace it with an observation time.
    const pending = this.relations.pendingLaunchWorkspaces()
    for (const workspace of this.launchHistoryAt.keys()) {
      if (!pending.has(workspace)) this.launchHistoryAt.delete(workspace)
    }
    const scopes = [...pending]
      .filter(
        (workspace) =>
          this.now() - (this.launchHistoryAt.get(workspace) ?? -Infinity) >= HISTORY_INTERVAL_MS
      )
      .slice(0, 4)
    await Promise.all(
      scopes.map(async (workspace) => {
        this.launchHistoryAt.set(workspace, this.now())
        await this.history(workspace)
      })
    )
    this.relations.refresh()
    for (const [route, identity] of this.identities) {
      if (!this.live.has(route) && this.now() - identity.since > 120000)
        this.identities.delete(route)
    }
    store.collectedUntil = this.now()
    store.prune(this.now())
  }

  async history(workspaceId) {
    if (!workspaceId) this.historyAt = this.now()
    const source = workspaceId ? `Session history · ${workspaceId}` : 'Session history'
    try {
      const result = await this.host.call('agent.listSessions', {
        ...(workspaceId && { workspaceId }),
        limit: 200
      })
      if (!Array.isArray(result.sessions)) throw new Error('Invalid session history')
      const now = this.now()
      // Summary timestamps must never insert an unknown boundary after observed state.
      // Include an existing history anchor so nullable createdAt cannot drift on refresh.
      const firstPoints = new Map()
      for (const point of this.store.points.values()) {
        firstPoints.set(
          point.agentId,
          Math.min(firstPoints.get(point.agentId) ?? Infinity, point.at)
        )
      }
      for (const row of result.sessions) {
        if (
          !row.sessionId ||
          !row.agent ||
          (workspaceId && row.workspaceId !== workspaceId) ||
          !Number.isFinite(row.updatedAt) ||
          row.updatedAt < now - WINDOW_MS
        )
          continue
        const workspace = this.workspaces.get(row.workspaceId)
        // Keep summaries whose original workspace is no longer available, without a navigation route.
        const id = sessionKey(row.workspaceId, row.agent, row.sessionId)
        this.store.agent(id, {
          sessionId: row.sessionId,
          provider: row.agent,
          workspace: row.workspaceId,
          workspaceName: workspace?.name,
          hostId: row.hostId,
          projectId: workspace?.projectId,
          projectName: workspace?.project || workspace?.name,
          label: row.title || `${row.agent} session`,
          labelSource: row.title ? 'conversation' : 'fallback',
          messageCount: row.messageCount,
          totalTokens: row.totalTokens,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          incompleteActivityHistory: true
        })
        const start = Math.min(
          now,
          row.updatedAt,
          Number.isFinite(row.createdAt) ? row.createdAt : row.updatedAt,
          firstPoints.get(id) ?? now
        )
        // Session lifetime and running do not describe execution intervals.
        this.store.point(
          `public-history:${id}`,
          id,
          start,
          'unknown',
          'history',
          Math.min(now, row.updatedAt)
        )
      }
      this.store.source(
        source,
        result.truncated ? 'limited' : 'ok',
        `${result.truncated ? 'Newest 200 sessions; additional sessions are unavailable. ' : ''}Summaries only; past execution states are unknown.`
      )
    } catch (error) {
      this.store.source(source, 'error', error.message)
    }
  }
}
