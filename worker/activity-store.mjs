import { projectKey, terminalKey } from '../pin-identity.mjs'
import { segmentAt, isActiveState, hasWindowActivity } from '../timeline-evidence.mjs'
import { viewWindow } from '../view-window.mjs'
import { normalizeWorkingRuns } from './working-runs.mjs'

export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const STATES = new Set(['working', 'blocked', 'waiting', 'done', 'unknown'])
const MAX_POINTS = 8196
const MAX_MESSAGES = 5000
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

const SHORT_TASK_MS = 3 * 60 * 1000

// Ready/idle alone proves a terminal exists, not that a conversation ever ran.
// Keep the observations in storage so later identity/activity can enrich them.
function isReadyPlaceholder(agent, points) {
  return (
    agent.paneKey &&
    !agent.providerSessionId &&
    !agent.sessionId &&
    !agent.dispatchId &&
    !agent.taskId &&
    !agent.runId &&
    !agent.parentId &&
    !agent.spawnedAt &&
    !agent.incompleteActivityHistory &&
    points.some((point) => point.state === 'done') &&
    points.every(
      (point) =>
        ['live', 'status-cache'].includes(point.source) && ['done', 'unknown'].includes(point.state)
    )
  )
}

function mergeIntervals(intervals) {
  const merged = []
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1)
    if (previous && previous[1] >= start) {
      previous[1] = Math.max(previous[1], end)
    } else if (end > start) {
      merged.push([start, end])
    }
  }
  return merged
}

// This measures recorded Working runs, including confirmed short internal gaps.
function isFinishedShortTask(agent, points) {
  const finish = points.at(-1)
  if (
    agent.incompleteActivityHistory ||
    points.some((point) => point.unsettled) ||
    finish?.state !== 'done' ||
    points.some((point) => point.at === finish.at && point.state !== 'done')
  ) {
    return false
  }
  const work = []
  const pauses = []
  const coverage = []
  for (let index = 0; index < points.length - 1; index++) {
    const point = points[index]
    const next = points[index + 1].at
    if (point.state === 'working') {
      if (!Number.isFinite(point.until) || point.until > finish.at) {
        return false
      }
      work.push([point.at, point.until])
      coverage.push([point.at, point.until])
    } else if (point.state === 'done') {
      coverage.push([point.at, Math.min(next, point.until ?? next)])
    } else if (point.state !== 'unknown' && Number.isFinite(point.until)) {
      const interval = [point.at, Math.min(next, point.until)]
      pauses.push(interval)
      coverage.push(interval)
    }
  }
  const execution = mergeIntervals(work)
  if (!execution.length) {
    return false
  }
  const start = execution[0][0]
  // Unknown observations and holes between bounded evidence cannot prove a short task.
  if (
    points.some(
      (point) =>
        point.state === 'unknown' &&
        point.source !== 'identity-change' &&
        point.at >= start &&
        point.at < finish.at
    ) ||
    !mergeIntervals(coverage).some(([from, to]) => from <= start && to >= finish.at)
  ) {
    return false
  }
  const excluded = mergeIntervals(pauses)
  let executionMs = 0
  for (const [from, to] of execution) {
    executionMs += to - from
    for (const [pauseStart, pauseEnd] of excluded) {
      executionMs -= Math.max(0, Math.min(to, pauseEnd) - Math.max(from, pauseStart))
    }
  }
  return executionMs > 0 && executionMs < SHORT_TASK_MS
}

// Optional fields can be absent on older records or on live host metadata.
// Keep null (for example an unknown message sender) and omit undefined object
// properties at the public snapshot boundary, including nested metadata.
function snapshotValue(value) {
  if (Array.isArray(value)) return value.map(snapshotValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, snapshotValue(field)])
  )
}

// Choose membership before sorting for display. Pins keep their existing priority;
// verified mail reserves both endpoints together, newest plotted time first. A pair
// that cannot fit is skipped, never converted into a receiver-only observation.
function selectLanes(agents, messages, pins, now, range) {
  const budget = 160
  if (agents.length <= budget) return agents
  const available = new Set(agents.map((agent) => agent.id))
  const selected = new Set(
    agents
      .filter((agent) => pins.has(terminalKey(agent)))
      .slice(0, budget)
      .map((agent) => agent.id)
  )
  const recent = [...messages]
    .filter(
      (message) =>
        message.at <= now &&
        ['Send accepted', 'Mailbox received', 'Mailbox input'].includes(message.type) &&
        (message.from === null || available.has(message.from)) &&
        available.has(message.to)
    )
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 600)
  for (const message of recent) {
    const missing = new Set(
      [message.from, message.to].filter((id) => id !== null && !selected.has(id))
    )
    if (selected.size + missing.size <= budget) {
      for (const id of missing) selected.add(id)
    }
  }
  const spawns = agents
    .filter(
      (agent) =>
        available.has(agent.parentId) &&
        agent.parentId !== agent.id &&
        Number.isFinite(agent.spawnedAt) &&
        agent.spawnedAt >= now - WINDOW_MS &&
        agent.spawnedAt <= now &&
        (!range || (agent.spawnedAt >= range.start && agent.spawnedAt <= range.end))
    )
    .sort((a, b) => b.spawnedAt - a.spawnedAt || a.id.localeCompare(b.id))
  for (const child of spawns) {
    const missing = [child.parentId, child.id].filter((id) => !selected.has(id))
    if (selected.size + missing.length <= budget) {
      for (const id of missing) selected.add(id)
    }
  }
  if (range) {
    // Use the panel's evidence rule before inactive summaries spend lane places.
    // Explicit pins and verified edge endpoints keep their existing reservations.
    for (const agent of agents) {
      if (selected.size === budget) break
      if (hasWindowActivity(agent, range.start, range.end)) selected.add(agent.id)
    }
  }
  for (const agent of agents) {
    if (selected.size === budget) break
    selected.add(agent.id)
  }
  // agents is already in stable display order; reservation order is not UI order.
  return agents.filter((agent) => selected.has(agent.id))
}

// A displayed message can reserve at most three intervals: both lanes at the
// plotted time and the receiver at retrieval. Even 600 messages fit in 4,000.
function limitTimeline(agents, messages, budget, preferActivity) {
  if (agents.reduce((sum, a) => sum + a.segments.length, 0) <= budget) return false
  const lanes = new Map(
    agents.map((agent) => [agent.id, { agent, keep: new Set(), next: agent.segments.length - 1 }])
  )
  function reserve(id, at) {
    const lane = lanes.get(id)
    if (!lane || !Number.isFinite(at)) return
    const segment = segmentAt(lane.agent.segments, at)
    if (segment) lane.keep.add(segment)
  }
  for (const message of messages) {
    reserve(message.from, message.at)
    reserve(message.to, message.at)
    reserve(message.to, message.deliveredAt)
  }
  // Keep the latest interval on every lane. Then fill equal-sized shares
  // newest first, letting sparse lanes and reservations sit out each round.
  for (const { agent, keep } of lanes.values()) {
    if (agent.segments.length) keep.add(agent.segments.at(-1))
    budget -= keep.size
  }
  for (const activityOnly of preferActivity ? [true, false] : [false]) {
    let active = [...lanes.values()].reverse()
    for (const lane of active) lane.next = lane.agent.segments.length - 1
    for (let share = 1; budget > 0; share++) {
      active = active.filter((lane) => {
        const { agent, keep } = lane
        while (
          lane.next >= 0 &&
          (keep.has(agent.segments[lane.next]) ||
            (activityOnly && !isActiveState(agent.segments[lane.next].state)))
        )
          lane.next--
        return lane.next >= 0
      })
      if (!active.length) break
      for (const lane of active) {
        const { agent, keep } = lane
        if (keep.size >= share) continue
        keep.add(agent.segments[lane.next--])
        if (--budget === 0) break
      }
    }
  }
  for (const { agent, keep } of lanes.values()) {
    const segments = agent.segments
    if (segments.length === keep.size) continue
    // Report exact omitted records; a retained Working record is already a run.
    agent.omittedSegments = segments.length - keep.size
    agent.omittedRanges = []
    agent.segments = []
    const activityBounds = []
    let hole
    for (const segment of segments) {
      if (!keep.has(segment)) {
        if (hole && hole.end === segment.start) hole.end = segment.end
        else {
          hole = { start: segment.start, end: segment.end }
          agent.omittedRanges.push(hole)
        }
        if (isActiveState(segment.state)) {
          if (activityBounds.at(-1) === segment.start)
            activityBounds[activityBounds.length - 1] = segment.end
          else activityBounds.push(segment.start, segment.end)
        }
        continue
      }
      hole = null
      agent.segments.push(segment)
    }
    if (activityBounds.length) agent.omittedActivity = activityBounds
  }
  return true
}

// Keep complete record boundaries when a viewport crosses a Working run.
// Mail retrieval can be outside the plotted send window and still needs evidence.
function windowTimeline(agents, messages, range) {
  const endpoints = new Map()
  const add = (id, at) => {
    if (!endpoints.has(id)) endpoints.set(id, [])
    endpoints.get(id).push(at)
  }
  for (const message of messages) {
    add(message.from, message.at)
    add(message.to, message.at)
    if (Number.isFinite(message.deliveredAt)) add(message.to, message.deliveredAt)
  }
  for (const agent of agents) {
    const segments = agent.segments
    const keep = new Set()
    let previous
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      if (segment.end <= range.start && segment.state !== 'unknown') previous = segment
      if (segment.end <= range.start || segment.start >= range.end) continue
      keep.add(segment)
    }
    if (previous) keep.add(previous)
    for (const at of endpoints.get(agent.id) ?? []) {
      const segment = segmentAt(segments, at)
      if (segment) keep.add(segment)
    }
    agent.segments = segments.filter((segment) => keep.has(segment))
    if (agent.stateEvents) {
      agent.stateEvents = agent.stateEvents.filter(
        (event) => event.at >= range.start && event.at <= range.end
      )
      if (!agent.stateEvents.length) delete agent.stateEvents
    }
  }
}

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
  terminalClosures = new Map()
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

  normalizeRuns() {
    const grouped = new Map()
    for (const point of this.points.values()) {
      if (!grouped.has(point.agentId)) grouped.set(point.agentId, [])
      grouped.get(point.agentId).push(point)
    }
    for (const [id, points] of grouped) {
      const agent = this.agents.get(id)
      if (!agent) continue
      const normalized = normalizeWorkingRuns(agent, points)
      if (normalized === points) continue
      for (const point of points) this.points.delete(point.id)
      for (const point of normalized) this.points.set(point.id, point)
    }
  }

  workingRunAt(agentId, at) {
    return [...this.points.values()].find(
      (point) =>
        point.agentId === agentId &&
        point.state === 'working' &&
        point.at <= at &&
        point.until >= at
    )
  }

  breakWorkingRun(agentId, at) {
    this.point(`identity-change:${agentId}:${at}`, agentId, at, 'unknown', 'identity-change', at)
  }

  message(message) {
    if (!message.id || !Number.isFinite(message.at)) {
      return
    }
    const prior = this.messages.get(message.id)
    const publicMail = message.id.startsWith('public-mail:')
    if (
      publicMail &&
      (prior?.senderConflict ||
        message.senderConflict ||
        (prior?.from && message.from && prior.from !== message.from))
    ) {
      // A retained conflict survives older generations and repeated receipts. Only
      // an observed retrieval provides a recipient or a display time in this case.
      const checks = [prior, message].filter((row) => Number.isFinite(row?.deliveredAt))
      const to = checks[0]?.to ?? null
      const at = checks.length
        ? Math.min(...checks.filter((row) => row.to === to).map((row) => row.deliveredAt))
        : Math.min(prior?.at ?? message.at, message.at)
      message = {
        id: message.id,
        senderConflict: true,
        from: null,
        to,
        at,
        ...(to && { deliveredAt: at, type: 'Mailbox input' })
      }
    } else if (publicMail && prior) {
      if (prior.to !== message.to) return
      const from = prior.from ?? message.from
      const received = [prior.deliveredAt, message.deliveredAt].filter(Number.isFinite)
      // Sender observations carry the acceptance time. A receiver-only marker
      // carries its check time, which can arrive in either callback order.
      const sendTimes = [prior, message].filter((row) => row.from).map((row) => row.at)
      message = {
        ...message,
        from,
        at: sendTimes.length ? Math.min(...sendTimes) : Math.min(prior.at, message.at),
        type: !from ? 'Mailbox input' : received.length ? 'Mailbox received' : 'Send accepted',
        ...(received.length && { deliveredAt: Math.min(...received) })
      }
    }
    this.messages.set(message.id, {
      ...message,
      from: message.from === null ? null : this.agent(message.from),
      to: message.to === null ? null : this.agent(message.to),
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
    if (agent.projectId && agent.projectName) {
      return { projectId: agent.projectId, projectName: agent.projectName }
    }
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
    this.normalizeRuns()
    const forgetPoint = (id, point) => {
      const agent = this.agents.get(point.agentId)
      if (agent) {
        agent.incompleteActivityHistory = true
      }
      this.points.delete(id)
    }
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
        forgetPoint(id, point)
      }
    }
    for (const anchor of anchors.values()) {
      if (anchor.until === undefined || anchor.until < cutoff) {
        forgetPoint(anchor.id, anchor)
      }
    }
    for (const [id, message] of this.messages) {
      if (message.at < cutoff) {
        this.messages.delete(id)
      }
    }
    const trim = (records, limit) => {
      if (records.size <= limit) {
        return
      }
      this.limited = true
      const ordered = [...records.values()].sort((a, b) => a.at - b.at)
      for (const item of ordered.slice(0, records.size - limit)) {
        if (records === this.points) {
          forgetPoint(item.id, item)
        } else {
          records.delete(item.id)
        }
      }
    }
    trim(this.points, MAX_POINTS)
    trim(this.messages, MAX_MESSAGES)
    const needed = new Set([...this.points.values()].map((point) => point.agentId))
    for (const message of this.messages.values()) {
      needed.add(message.from)
      needed.add(message.to)
    }
    for (const agent of this.agents.values()) {
      if (
        agent.parentId &&
        agent.spawnedAt >= cutoff &&
        agent.spawnedAt <= now &&
        !agent.dispatchFailed
      )
        needed.add(agent.id)
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

  // Raw consumers retain the unfiltered view; panel/preview endpoints supply the preference.
  snapshot(
    now = Date.now(),
    {
      hideShortTasks = false,
      attempts = [],
      pinnedTerminals = [],
      pinnedProjects = [],
      view,
      segmentBudget = 4000,
      preferActivity = false
    } = {}
  ) {
    this.prune(now)
    const windowStart = now - WINDOW_MS
    const range = viewWindow(now, windowStart, view)
    const pins = new Set(pinnedTerminals)
    const projects = new Set(pinnedProjects)
    const headings = new Map()
    const grouped = new Map()
    for (const point of this.points.values()) {
      if (point.at > now) {
        continue
      }
      const points = grouped.get(point.agentId) ?? []
      points.push(point)
      grouped.set(point.agentId, points)
    }
    let hiddenShortTasks = 0
    const agents = [...this.agents.values()]
      .filter((agent) => !isReadyPlaceholder(agent, grouped.get(agent.id) ?? []))
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
        const stateEvents = []
        let lastObserved
        let lastObservedEnd
        let displayWork = 0
        for (let index = 0; index < points.length; index++) {
          const point = points[index]
          const next = points[index + 1]?.at ?? now
          const end = Math.min(now, next, point.until ?? next)
          const start = Math.max(windowStart, point.at)
          // A new bounded Done interval can simply be the first poll after a gap.
          // Use the first observed Done after an active state, even if it occupies no pixels.
          const completion =
            point.state === 'done' &&
            lastObserved &&
            lastObserved.state !== 'done' &&
            lastObserved.at < point.at &&
            point.at >= windowStart
          const completionSince = completion ? lastObservedEnd : undefined
          if (point.state !== 'unknown') {
            if (
              end === point.at &&
              point.at >= windowStart &&
              (point.state !== 'done' || completion)
            )
              stateEvents.push({
                at: point.at,
                state: point.state,
                ...(completion && { completionSince })
              })
            lastObserved = point
            lastObservedEnd = end
          }
          if (point.state === 'working' && start <= end) {
            displayWork += end - start
          }
          if (end > start) {
            segments.push({
              start,
              end,
              state: point.state,
              ...(point.source !== undefined && { source: point.source }),
              ...(completion && { completionSince })
            })
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
        const member = snapshotValue({ ...agent, ...this.projectFor(agent) })
        const key = projectKey(member)
        if (projects.has(key)) {
          const { hostId, projectId, projectName } = member
          headings.set(key, snapshotValue({ hostId, projectId, projectName }))
        }
        const pinned = pins.has(terminalKey(agent))
        const shortTask =
          hideShortTasks && displayWork < SHORT_TASK_MS && isFinishedShortTask(agent, ordered)
        if (shortTask && !pinned) {
          hiddenShortTasks++
          return null
        }
        return {
          ...member,
          ...(pinned && { pinned }),
          segments,
          ...(shortTask && { pinnedShortTask: true }),
          ...(stateEvents.length && { stateEvents })
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    // Reserve snapshot places for explicitly pinned identities before the normal lane cap.
    if (agents.length > 160 && pins.size)
      agents.sort((a, b) => Number(pins.has(terminalKey(b))) - Number(pins.has(terminalKey(a))))
    const candidates = [...this.messages.values(), ...attempts].filter(
      (message) =>
        message.at <= now && (!range || (message.at >= range.start && message.at <= range.end))
    )
    const visible = selectLanes(agents, candidates, pins, now, range)
    const ids = new Set(visible.map((agent) => agent.id))
    const messages = candidates
      .filter(
        (message) =>
          message.at <= now &&
          (message.from === null || ids.has(message.from)) &&
          ids.has(message.to)
      )
      .sort((a, b) => a.at - b.at)
    const shown = messages.slice(-600)
    if (range) windowTimeline(visible, shown, range)
    // Internal reply sizing may lower the fill budget, never the reservations.
    const trimmed = limitTimeline(
      visible,
      shown,
      Math.max(0, Math.min(4000, segmentBudget)),
      preferActivity
    )
    return {
      now,
      windowStart,
      ...(range && { view: range }),
      agents: visible,
      pinnedProjects: [...headings.values()],
      messages: shown.map(snapshotValue),
      sources: [...this.sources.values()].slice(0, 200).map(snapshotValue),
      collectingSince: this.collectingSince,
      hiddenShortTasks,
      limited:
        this.limited || trimmed || agents.length > visible.length || messages.length > shown.length
    }
  }

  serialize() {
    this.normalizeRuns()
    return {
      agents: [...this.agents.values()],
      aliases: [...this.aliases],
      points: [...this.points.values()],
      messages: [...this.messages.values()],
      collectingSince: this.collectingSince,
      collectedUntil: this.collectedUntil
    }
  }

  recover(history) {
    const conflicts = new Set()
    for (const [id, recorded] of history.agents) {
      const live = this.agents.get(id)
      if (
        live &&
        ['sessionId', 'workspace', 'provider'].some(
          (field) => live[field] && recorded[field] && live[field] !== recorded[field]
        )
      )
        conflicts.add(id)
    }
    for (const [id, recorded] of history.agents) {
      if (conflicts.has(id)) continue
      const live = this.agents.get(id)
      if (!live && !conflicts.has(recorded.parentId)) {
        this.agents.set(id, recorded)
        continue
      }
      const { parentId, spawnedAt, ...details } = recorded
      // Session metadata absent from the first inventory (e.g. history totals)
      // survives recovery; a newly observed route or summary takes precedence.
      const merged = { ...details, ...live }
      if (live && namePriority(recorded) > namePriority(live)) {
        merged.label = recorded.label
        merged.labelSource = recorded.labelSource
      }
      this.agents.set(id, merged)
      if (
        parentId &&
        Number.isFinite(spawnedAt) &&
        !conflicts.has(parentId) &&
        (!live?.parentId || live.parentId === parentId)
      ) {
        this.agent(id, { parentId, spawnedAt })
      }
    }
    for (const [alias, id] of history.aliases) {
      if (!this.aliases.has(alias) && !conflicts.has(id)) this.aliases.set(alias, id)
    }
    for (const [id, point] of history.points) {
      if (!this.points.has(id) && !conflicts.has(point.agentId)) this.points.set(id, point)
    }
    for (const [id, mail] of history.messages) {
      if (conflicts.has(mail.from) || conflicts.has(mail.to)) continue
      if (!this.messages.has(id)) this.messages.set(id, mail)
      else if (id.startsWith('public-mail:')) this.message(mail)
    }
    this.collectingSince = Math.min(this.collectingSince, history.collectingSince)
    this.normalizeRuns()
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
        if (point.state === 'working') point.unsettled = true
      }
    }
    this.prune(now)
  }
}
