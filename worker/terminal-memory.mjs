import { resolve } from 'node:path'
import { defaultDataDirectory } from './orca-log-reader.mjs'
import { createSessionTabClient } from './session-tab-client.mjs'

const INTERVAL_MS = 30_000
const MAX_AGE_MS = 60_000
const METRICS = new Set(['footprint', 'rss', 'working-set'])
const address = (agent) => JSON.stringify([agent.terminalHandle, agent.workspace, agent.paneKey])
const workspaceOf = (agent) => agent.workspace.replace(/^worktree:/, '')

export class TerminalMemory {
  samples = new Map()
  nextPoll = 0
  pending = null
  closed = false

  constructor(store, directories, changed = () => {}, connect = createSessionTabClient) {
    this.store = store
    this.directory =
      directories.length === 1 && resolve(directories[0]) === resolve(defaultDataDirectory())
        ? directories[0]
        : null
    this.changed = changed
    this.connect = connect
  }

  current(agent) {
    return Boolean(
      agent.workspace &&
      agent.paneKey &&
      !agent.paneKey.startsWith('structured-agent-session-') &&
      this.store.aliases.get(`pane:${agent.paneKey}`) === agent.id
    )
  }

  snapshot(snapshot, now = Date.now()) {
    if (this.closed || !this.directory) return snapshot
    const agents = snapshot.agents.filter((agent) => this.current(agent))
    if (!this.pending && now >= this.nextPoll && agents.length) {
      this.nextPoll = now + INTERVAL_MS
      this.pending = this.collect(agents)
        .catch(() => this.samples.clear())
        .finally(() => {
          this.pending = null
          if (!this.closed) this.changed()
        })
    }
    return {
      ...snapshot,
      agents: snapshot.agents.map((agent) => {
        const sample = this.samples.get(agent.id)
        return sample &&
          this.current(agent) &&
          sample.address === address(agent) &&
          sample.collectedAt <= now &&
          now - sample.collectedAt <= MAX_AGE_MS
          ? {
              ...agent,
              memory: {
                bytes: sample.bytes,
                metric: sample.metric,
                collectedAt: sample.collectedAt
              }
            }
          : agent
      })
    }
  }

  async collect(agents) {
    const request = await this.connect(this.directory)
    const memory = await request('diagnostics.memory', {})
    const now = Date.now()
    if (
      !METRICS.has(memory?.processMemoryMetric) ||
      !Number.isFinite(memory.collectedAt) ||
      memory.collectedAt > now ||
      now - memory.collectedAt > MAX_AGE_MS
    ) {
      throw new Error('Memory snapshot is unavailable or stale.')
    }
    const groups = new Map()
    for (const agent of agents) {
      const workspace = workspaceOf(agent)
      if (!groups.has(workspace)) groups.set(workspace, [])
      groups.get(workspace).push(agent)
    }
    const next = new Map()
    for (const [workspace, candidates] of groups) {
      if (this.closed) return
      const sessions = (memory.worktrees ?? [])
        .filter((row) => row.worktreeId === workspace)
        .flatMap((row) => row.sessions ?? [])
      if (!sessions.length) continue
      let terminals
      try {
        const result = await request('terminal.list', {
          worktree: `id:${workspace}`,
          limit: 256,
          includePreview: false,
          includeVisualLayouts: false,
          requireFreshPtyLiveness: true
        })
        if (result.truncated) continue
        terminals = result.terminals ?? []
      } catch {
        continue
      }
      for (const agent of candidates) {
        const matches = terminals.filter(
          (terminal) =>
            terminal.worktreeId === workspace &&
            `${terminal.tabId}:${terminal.leafId}` === agent.paneKey &&
            terminal.executionHostId === 'local' &&
            terminal.connected &&
            !terminal.orphaned &&
            (terminal.verdict === undefined || terminal.verdict === 'live')
        )
        if (matches.length !== 1) continue
        const samples = sessions.filter(
          (session) =>
            session.sessionId === matches[0].ptyId &&
            session.paneKey === agent.paneKey &&
            Number.isSafeInteger(session.pid) &&
            session.pid > 0 &&
            Number.isFinite(session.memory) &&
            session.memory >= 0
        )
        if (samples.length !== 1) continue
        next.set(agent.id, {
          address: address(agent),
          bytes: samples[0].memory,
          metric: memory.processMemoryMetric,
          collectedAt: memory.collectedAt
        })
      }
    }
    if (!this.closed) this.samples = next
  }

  close() {
    this.closed = true
    this.samples.clear()
  }
}
