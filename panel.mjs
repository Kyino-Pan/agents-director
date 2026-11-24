import { projectKey, terminalKey } from './pin-identity.mjs'
import { t, number, date, unit, locale, updateLocale, bindDocumentText } from './panel-i18n.mjs'
import {
  segmentAt,
  completionInWindow,
  eventInWindow,
  overlapsOmittedActivity
} from './timeline-evidence.mjs'
import { DetailInputs } from './panel-inputs.mjs'
import {
  windowActivity,
  activeAgents,
  agentName,
  overlapsOmittedRange,
  renderActivityDetail,
  visibleAgents
} from './panel-identity.mjs'
import { harnessIcon, harnessLabel, shortAgentId } from './panel-harness.mjs'
import { installActivityActions, renderSources } from './panel-actions.mjs'
import { createLaneMotion, spawnPath, messagePath } from './lane-motion.mjs'
import { loadViewPreferences } from './view-preferences.mjs'

const HOUR = 3_600_000
const ROW = 32
const GROUP = 30
let minHours = 1 / 12
let maxHours = 168
const SVG = 'http://www.w3.org/2000/svg'
const STATES = new Set(['working', 'blocked', 'waiting', 'done', 'unknown'])
const $ = (id) => document.getElementById(id)
const applyDocumentText = bindDocumentText(document.body)
function localizeDocument() {
  applyDocumentText()
  if ($('plugin-version').dataset.unavailable)
    $('plugin-version').textContent = t('Version unavailable')
  $('pause').textContent = t(
    $('pause').getAttribute('aria-pressed') === 'true' ? 'Resume live' : 'Pause view'
  )
  $('zoom-min').textContent = unit(5, 'minute', true)
  $('zoom-value').textContent = unit(24, 'hour', true)
  $('zoom-limit').textContent = unit(7, 'day', true)
  for (const tick of $('zoom-ticks').children) localizeTick(tick, Number(tick.dataset.hours))
}
updateLocale()
localizeDocument()
// The desktop frame serves its own integrity-checked package assets by relative URL.
async function showVersion() {
  try {
    const response = await fetch('./orca-plugin.json')
    const manifest = response.ok && (await response.json())
    if (typeof manifest.version === 'string' && manifest.version) {
      $('plugin-version').textContent = 'v' + manifest.version
      return
    }
  } catch {
    // The rest of the timeline remains usable when the package asset cannot be read.
  }
  $('plugin-version').dataset.unavailable = 'true'
  $('plugin-version').textContent = t('Version unavailable')
}
void showVersion()
const dateFormatter = (options) => ({ format: (at) => date(at, options) })
const timeFormat = dateFormatter({ hour: '2-digit', minute: '2-digit' })
const eventTime = dateFormatter({
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3
})
const dayFormat = dateFormatter({ month: 'short', day: 'numeric' })
const dayHourFormat = dateFormatter({
  month: 'short',
  day: 'numeric',
  hour: '2-digit'
})
const dateFormat = dateFormatter({
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
let latest = null
let displayed = null
let displayedHideShortTasks = null
const preferences = await loadViewPreferences()
$('language').value = preferences.language
if (updateLocale(preferences.language)) localizeDocument()
let hours = preferences.hours
let viewEnd = null
let paused = false
let pending = false
let rerun = false
let selection = null
let disposed = false
let subscription
let resizeFrame = null
let renderedWidth = 0
let renderedHeight = 0
let renderedZoomWidth = 0
let renderedAgents = []
const laneEvidence = new Map()
let gestureAgents = null
let gestureTimer
const laneMotion = createLaneMotion($('lanes'), $('chart'))

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) {
    element.className = className
  }
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

function svg(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value))
  }
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

function stateOf(segment) {
  return STATES.has(segment?.state) ? segment.state : 'unknown'
}

function stateLabel(state) {
  return t(state === 'unknown' ? 'Unobserved' : state[0].toUpperCase() + state.slice(1))
}

function windowLabel(value) {
  if (value > 24 && value % 24 === 0) return unit(value / 24, 'day', true)
  return duration(value * HOUR, true)
}

function zoomFraction(value) {
  return maxHours === minHours ? 0 : Math.log(value / minHours) / Math.log(maxHours / minHours)
}

function renderZoom(snapshot) {
  maxHours = Math.min(168, Math.max(1 / 60, (snapshot.now - snapshot.windowStart) / HOUR))
  minHours = Math.min(1 / 12, maxHours)
  hours = Math.min(preferences.hours, maxHours)
  $('zoom').disabled = maxHours === minHours
  $('zoom').value = String(Math.round(zoomFraction(hours) * 1000))
  $('zoom').setAttribute(
    'aria-valuetext',
    t('{duration} of observed history', { duration: duration(hours * HOUR) })
  )
  $('zoom-min').textContent = windowLabel(minHours)
  $('zoom-limit').textContent = windowLabel(maxHours)
  $('zoom-value').textContent = windowLabel(hours)
  const width = $('zoom-ticks').clientWidth
  renderedZoomWidth = width
  let previousPosition = -Infinity
  for (const tick of $('zoom-ticks').children) {
    const value = Number(tick.dataset.hours)
    const fraction = zoomFraction(value)
    const position = fraction * width
    tick.hidden = value < minHours || value > maxHours || position - previousPosition < 36
    if (!tick.hidden) {
      tick.style.left = `${fraction * 100}%`
      previousPosition = position
    }
  }
}

function unobservedDescription(agent, segment) {
  const previous = agent.segments.findLast(
    (item) => item.end <= (segment?.start ?? Infinity) && stateOf(item) !== 'unknown'
  )
  const omitted = overlapsOmittedRange(
    agent,
    previous?.end ?? -Infinity,
    segment?.start ?? Infinity
  )
  const earlier = previous
    ? t(
        omitted
          ? 'Last retained observation: {state} through {time}.'
          : 'Last observed: {state} through {time}.',
        { state: stateLabel(stateOf(previous)), time: dateFormat.format(previous.end) }
      )
    : t('No earlier state observation is available in this snapshot.')
  return (
    t(
      'No reliable state observation covers this interval. Missing or stale logs cannot confirm continued work.'
    ) +
    '\n' +
    earlier
  )
}

function evidenceInWindow(agent, start, end, hasMessages) {
  const last = agent.segments.findLast(
    (item) => item.end > start && item.start < end && stateOf(item) !== 'unknown'
  )
  const limited = overlapsOmittedRange(agent, start, end)
  // Intervals exclude their right boundary. A confirmed completion exactly at the view end
  // still belongs to the window even though its following interval has no visible width.
  const boundary = agent.segments.findLast(
    (item) => item.start === end && completionInWindow(item, start, end)
  )
  const event = boundary
    ? { at: end, state: 'done' }
    : agent.stateEvents?.findLast((event) => eventInWindow(event, start, end))
  const showEvent = event && (!last || event.at >= last.end)
  let label = t('Unobserved')
  let detail = t('No state interval is available in this window.')
  if (showEvent) {
    const state = stateLabel(event.state)
    label =
      event.at === end
        ? state
        : t(
            overlapsOmittedRange(agent, event.at, end) ? 'Last retained: {state}' : 'Last: {state}',
            { state }
          )
    detail = t('Observed {state} at {time}.', { state, time: eventTime.format(event.at) })
  } else if (last) {
    const state = stateLabel(last.state)
    label = state
    if (last.end < end) {
      label = t(
        overlapsOmittedRange(agent, last.end, end) ? 'Last retained: {state}' : 'Last: {state}',
        { state }
      )
    }
    detail = t('{state} observed through {time} in this window.', {
      state,
      time: dateFormat.format(Math.min(last.end, end))
    })
  } else if (limited) {
    label = t('History limited')
  } else if (hasMessages) {
    label = t('Messages only')
    detail = t(
      'Coordination messages are recorded in this window. No execution state interval is available here.'
    )
  }
  if (limited)
    detail +=
      ' ' +
      t(
        overlapsOmittedActivity(agent, start, end)
          ? 'Recorded activity in this window was omitted from the snapshot ({count} segments omitted across this lane).'
          : 'Some intervals in this window were omitted from the snapshot ({count} segments omitted across this lane).',
        { count: number(agent.omittedSegments) }
      )
  return { state: stateOf(showEvent ? event : last), label, detail }
}

function segmentDuration(ms) {
  if (ms < 1000) return unit(ms, 'millisecond')
  if (ms < 60000) return unit(ms / 1000, 'second')
  return duration(ms)
}

function duration(ms, compact = false) {
  if (ms < 60_000) {
    return t('< 1 min')
  }
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return unit(minutes, 'minute', compact)
  const hoursText = unit(Math.floor(minutes / 60), 'hour', true)
  return compact && minutes % 60 === 0
    ? hoursText
    : hoursText + ' ' + unit(minutes % 60, 'minute', true)
}

function setEmpty(title, body) {
  $('empty').replaceChildren(node('strong', '', title), node('p', '', body))
  $('empty').hidden = false
  $('chart-scroll').hidden = true
}

function pinButton(field, key, name, pinned) {
  const button = node('button', 'pin-control')
  button.type = 'button'
  button.dataset.pin = field
  button.dataset.pinKey = key
  button.dataset.key = field + ':' + key
  button.setAttribute('aria-pressed', String(pinned))
  const action =
    field === 'pinnedProjects'
      ? pinned
        ? 'Unpin project {name}'
        : 'Pin project {name}'
      : pinned
        ? 'Unpin terminal {name}'
        : 'Pin terminal {name}'
  button.title = (pinned ? t('Pinned') + ' · ' : '') + t(action, { name })
  button.setAttribute('aria-label', button.title)
  const icon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' })
  icon.append(svg('path', { d: 'M8 3h8l-1 7 3 3v2H6v-2l3-3z M12 15v6' }))
  button.append(icon)
  return button
}

function render() {
  if (!displayed) {
    return
  }
  const activeKey = document.hasFocus() ? document.activeElement?.getAttribute('data-key') : null
  const previousLanes = gestureAgents ? new Map() : laneMotion.capture()
  const snapshot = displayed
  renderZoom(snapshot)
  $('hide-short-tasks').setAttribute('aria-pressed', String(preferences.hideShortTasks))
  $('shorten-links').setAttribute('aria-pressed', String(preferences.compactLanes))
  const end = Math.min(
    snapshot.now,
    Math.max(snapshot.windowStart + hours * HOUR, viewEnd ?? snapshot.now)
  )
  const start = Math.max(snapshot.windowStart, end - hours * HOUR)
  const inWindow = (segment) => segment.end > start && segment.start < end
  const pins = new Set(snapshot.agents.filter((agent) => agent.pinned).map(terminalKey))
  const activity = windowActivity(snapshot, start, end)
  const active = gestureAgents
    ? activeAgents(snapshot, start, end, pins, activity)
    : visibleAgents(snapshot, start, end, preferences.compactLanes, pins, activity)
  if (gestureAgents) {
    const placed = new Set(gestureAgents.map((agent) => agent.id))
    for (const agent of active) {
      if (!placed.has(agent.id)) {
        gestureAgents.push(agent)
        placed.add(agent.id)
      }
    }
  }
  const currentAgents = new Map(snapshot.agents.map((agent) => [agent.id, agent]))
  const ordered = gestureAgents
    ? gestureAgents.map((agent) => currentAgents.get(agent.id) ?? agent)
    : active
  const projectPins = new Set((snapshot.pinnedProjects ?? []).map(projectKey))
  const groups = new Map()
  function group(agent) {
    const key = projectKey(agent)
    if (!groups.has(key))
      groups.set(key, { key, name: agent.projectName || t('Project unavailable'), agents: [] })
    return groups.get(key)
  }
  for (const agent of ordered) group(agent).agents.push(agent)
  const query = $('search').value.trim().toLocaleLowerCase(locale)
  for (const agent of snapshot.pinnedProjects ?? []) {
    // Keep a pinned project heading available even when all its lanes are idle.
    if (
      [agent.projectName, agent.projectId].some((value) =>
        value?.toLocaleLowerCase(locale).includes(query)
      )
    )
      group(agent)
  }
  const headings = [...groups.values()].sort(
    (a, b) => Number(projectPins.has(b.key)) - Number(projectPins.has(a.key))
  )
  const positions = new Map()
  let height = 0
  for (const heading of headings) {
    heading.y = height
    height += GROUP
    if (pins.size)
      heading.agents.sort(
        (a, b) => Number(pins.has(terminalKey(b))) - Number(pins.has(terminalKey(a)))
      )
    for (const agent of heading.agents) {
      positions.set(agent.id, height + ROW / 2)
      height += ROW
    }
  }
  const agents = headings.flatMap((heading) => heading.agents)
  renderedAgents = agents
  const rowById = new Map(agents.map((agent, index) => [agent.id, index]))
  const localDate = (at) => {
    const date = new Date(at - new Date(at).getTimezoneOffset() * 60000)
    return date.toISOString().slice(0, 16)
  }
  if (document.activeElement !== $('range-start')) {
    $('range-start').value = localDate(start)
  }
  if (document.activeElement !== $('range-end')) {
    $('range-end').value = localDate(end)
  }
  const windowMessages = snapshot.messages.filter(
    (message) => message.at >= start && message.at <= end
  )
  const participants = new Set(windowMessages.flatMap((message) => [message.from, message.to]))
  const messages = windowMessages.filter(
    (message) => (message.from === null || rowById.has(message.from)) && rowById.has(message.to)
  )
  if (selection?.agent && !rowById.has(selection.agent)) selection = null
  if (selection?.start !== undefined) {
    const segment = segmentAt(currentAgents.get(selection.agent)?.segments ?? [], selection.start)
    if (segment?.start !== selection.start || !inWindow(segment)) selection = null
  }
  if (selection?.message) {
    const visible = new Set(messages.map((item) => item.id))
    if (!visible.has(selection.message)) {
      const surviving = selection.messages.find((id) => visible.has(id))
      if (surviving) selection.message = surviving
      else selection = null
    }
  }
  const agentCount = t(
    snapshot.agents.length === 1 ? '{shown} of {total} agent' : '{shown} of {total} agents',
    {
      shown: number(active.length),
      total: number(snapshot.agents.length)
    }
  )
  const messageCount = t(
    messages.length === 1 ? '{count} coordination message' : '{count} coordination messages',
    { count: number(messages.length) }
  )
  $('summary').textContent = agentCount + ' · ' + messageCount
  $('period').textContent = `${dateFormat.format(start)} – ${dateFormat.format(end)}`
  renderSources(snapshot, node, dateFormat)
  $('view-empty').hidden = active.length > 0
  if (!snapshot.agents.length && !headings.length) {
    $('lanes').replaceChildren()
    $('chart').replaceChildren()
    $('axis').replaceChildren()
    setEmpty(
      t(snapshot.hiddenShortTasks ? 'Short tasks are hidden' : 'No activity observed yet'),
      snapshot.hiddenShortTasks
        ? t(
            snapshot.hiddenShortTasks === 1
              ? '{count} finished task has less than 3 minutes of reliably observed execution. Turn off Hide short tasks (< 3 min) to show it.'
              : '{count} finished tasks have less than 3 minutes of reliably observed execution. Turn off Hide short tasks (< 3 min) to show them.',
            { count: number(snapshot.hiddenShortTasks) }
          )
        : t(
            'Start an Orca agent to see its activity here. Check Data sources if an existing agent is missing.'
          )
    )
    renderDetail()
    return
  }
  $('empty').hidden = true
  $('chart-scroll').hidden = false
  renderedWidth = $('chart-scroll').clientWidth
  renderedHeight = $('chart-scroll').clientHeight
  height = Math.max(height, $('chart-scroll').clientHeight - 34)
  const width = Math.max(1, $('plot').clientWidth)
  const padding = 28
  const x = (at) => padding + ((at - start) / Math.max(1, end - start)) * (width - padding * 2)
  const center = (id) => positions.get(id)
  const labels = []
  laneEvidence.clear()
  for (const group of headings) {
    const row = node('div', 'project-row')
    row.append(node('div', 'project-heading', group.name))
    if (group.key)
      row.append(pinButton('pinnedProjects', group.key, group.name, projectPins.has(group.key)))
    labels.push(row)
    for (const agent of group.agents) {
      const lane = node('button', 'lane')
      lane.type = 'button'
      lane.dataset.key = `agent:${agent.id}`
      lane.dataset.agent = agent.id
      const evidence = evidenceInWindow(agent, start, end, participants.has(agent.id))
      const pinned = pins.has(terminalKey(agent))
      if (pinned && !activity.has(agent.id)) {
        evidence.label = t('No activity in this window')
        evidence.detail =
          t('This pinned terminal has no recorded activity in this window.') + ' ' + evidence.detail
      }
      if (agent.pinnedShortTask)
        evidence.detail +=
          ' ' + t('Pinned terminal with less than 3 minutes of reliably observed execution.')
      laneEvidence.set(agent.id, evidence)
      const label = agentName(agent)
      const identity = `${harnessLabel(agent)} · ${shortAgentId(agent)}`
      lane.setAttribute(
        'aria-label',
        t('{label}: {state}. {identity}. Inspect agent', { label, state: evidence.label, identity })
      )
      const status = node('span', `lane-state ${evidence.state}`, evidence.label)
      status.title = evidence.detail
      const meta = node('span', 'lane-meta')
      meta.append(status, node('span', 'lane-identity', shortAgentId(agent)))
      const heading = node('span', 'lane-heading')
      heading.append(harnessIcon(agent), node('span', 'lane-name', label))
      const memory = agent.memory
      if (
        Number.isFinite(memory?.bytes) &&
        memory.bytes >= 0 &&
        ['footprint', 'rss', 'working-set'].includes(memory.metric) &&
        Number.isFinite(memory.collectedAt)
      ) {
        const gib = memory.bytes >= 1024 ** 3
        const value = gib
          ? number(memory.bytes / 1024 ** 3, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
          : number(Math.round(memory.bytes / 1024 ** 2))
        const text = `${value} ${gib ? 'GiB' : 'MiB'}`
        const description = t(
          'Live terminal and child processes: {size} ({metric}), sampled {time}',
          {
            size: text,
            metric: memory.metric,
            time: new Date(memory.collectedAt).toLocaleTimeString(locale)
          }
        )
        const badge = node('span', 'lane-memory', text)
        badge.title = description
        meta.append(badge)
        lane.setAttribute('aria-label', `${lane.getAttribute('aria-label')}. ${description}`)
      }
      lane.append(heading, meta)
      const row = node('div', 'lane-row')
      row.append(lane, pinButton('pinnedTerminals', terminalKey(agent), label, pinned))
      labels.push(row)
    }
  }
  $('lanes').replaceChildren(...labels)
  const chart = $('chart')
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`)
  chart.style.height = `${height}px`
  const defs = svg('defs')
  const marker = svg('marker', {
    id: 'message-arrow',
    viewBox: '0 0 8 8',
    // Place the arrowhead just outside the receiving track to keep its direction visible.
    refX: 11,
    refY: 4,
    markerWidth: 8,
    markerHeight: 8,
    orient: 'auto-start-reverse'
  })
  marker.append(
    svg('path', {
      d: 'M 1 1 L 7 4 L 1 7',
      fill: 'none',
      stroke: 'var(--orca-foreground)',
      'stroke-width': 1.5
    })
  )
  const spawnEnd = svg('marker', {
    id: 'spawn-arrow',
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 4,
    markerHeight: 4,
    orient: 'auto'
  })
  spawnEnd.append(svg('path', { d: 'M 0 1 L 7 4 L 0 7 Z', fill: 'var(--orca-muted-foreground)' }))
  defs.append(marker, spawnEnd)
  chart.replaceChildren(defs)
  $('axis').replaceChildren()
  const ticks = Math.max(1, Math.min(6, Math.floor((width - padding * 2) / 100)))
  for (let tick = 0; tick <= ticks; tick++) {
    const at = start + ((end - start) * tick) / ticks
    const compactDate = ticks <= 2 && hours >= 24
    const label = node(
      'span',
      compactDate ? 'axis-date' : '',
      compactDate
        ? `${dayFormat.format(at)}\n${timeFormat.format(at)}`
        : hours > 24
          ? (hours < 72 ? dayHourFormat : dayFormat).format(at)
          : timeFormat.format(at)
    )
    label.style.left = `${x(at)}px`
    $('axis').append(label)
    chart.append(svg('line', { x1: x(at), x2: x(at), y1: 0, y2: height, class: 'grid-line' }))
  }
  for (const heading of headings) {
    chart.append(
      svg('line', { x1: 0, x2: width, y1: heading.y, y2: heading.y, class: 'project-line' })
    )
  }
  const segments = svg('g')
  agents.forEach((agent) => {
    // Draw one continuous bar underneath the original segment hit targets.
    // Their labels and click details still describe the actual short transitions.
    let run
    for (const segment of agent.segments) {
      if (!inWindow(segment)) continue
      if (segment.state !== 'working' && !segment.joinedWork) {
        run = null
        continue
      }
      if (!run || run.end !== segment.start) run = { left: x(Math.max(start, segment.start)) }
      run.end = segment.end
      if (segment.joinedWork && !run.rect) {
        run.rect = svg('rect', {
          x: run.left,
          y: center(agent.id) - 3,
          height: 6,
          rx: 1,
          class: 'working run-bar',
          'data-agent': agent.id,
          'aria-hidden': true
        })
        segments.append(run.rect)
      }
      run.rect?.setAttribute('width', x(Math.min(end, segment.end)) - run.left)
    }
    agent.segments.forEach((segment, index) => {
      if (!inWindow(segment)) {
        return
      }
      const left = x(Math.max(start, segment.start))
      const barWidth = Math.max(0, x(Math.min(end, segment.end)) - left)
      const state = stateOf(segment)
      const paint = segment.joinedWork ? 'working' : state
      const key = `segment:${agent.id}:${segment.start}`
      const label = t('{label}: {state}, {start} to {end}, {duration}', {
        label: agentName(agent),
        state: stateLabel(state),
        start: dateFormat.format(segment.start),
        end: timeFormat.format(segment.end),
        duration: segmentDuration(segment.end - segment.start)
      })
      const group = svg('g', {
        class: 'segment-target',
        role: 'button',
        tabindex: 0,
        'aria-label': label,
        'data-key': key,
        'data-agent': agent.id,
        'data-segment': index
      })
      group.append(
        svg('title', {}, label),
        svg('rect', {
          x: left,
          y: center(agent.id) - 12,
          width: Math.max(8, barWidth),
          height: 24,
          rx: 3,
          class: 'segment-hit'
        }),
        svg('rect', {
          x: left,
          y: center(agent.id) - 3,
          width: barWidth,
          height: 6,
          rx: paint === 'unknown' ? 0 : 1,
          class: `segment ${paint}${segment.end >= end ? ' current' : ''}`
        })
      )
      segments.append(group)
    })
  })
  chart.append(segments)
  for (const agent of agents) {
    if (
      !rowById.has(agent.parentId) ||
      !Number.isFinite(agent.spawnedAt) ||
      agent.spawnedAt < start ||
      agent.spawnedAt > end
    ) {
      continue
    }
    const at = x(agent.spawnedAt)
    const from = center(agent.parentId)
    const to = center(agent.id)
    chart.append(
      svg('path', {
        class: 'spawn',
        'marker-end': 'url(#spawn-arrow)',
        'aria-label': t('Spawn: {from} → {to}', {
          from: agentName(agents[rowById.get(agent.parentId)]),
          to: agentName(agent)
        }),
        'data-from': agent.parentId,
        'data-to': agent.id,
        'data-x': at,
        d: spawnPath(at, from, to)
      })
    )
  }
  const messageBins = new Map()
  for (const message of messages) {
    const key = `${Math.floor(x(message.at) / 12)}:${message.from}:${message.to}`
    if (!messageBins.has(key)) {
      messageBins.set(key, [])
    }
    messageBins.get(key).push(message)
  }
  for (const bin of messageBins.values()) {
    const message = bin[0]
    const at = x(message.at)
    const to = center(message.to)
    const input = message.from === null
    const from = input ? to : center(message.from)
    const path = messagePath(at, from, to)
    const fromName = input ? t('Mailbox input') : agentName(agents[rowById.get(message.from)])
    const toName = agentName(agents[rowById.get(message.to)])
    const observedAt = (id) =>
      stateOf(segmentAt(currentAgents.get(id).segments, message.at)) !== 'unknown'
    const fromObserved = !input && observedAt(message.from)
    const counts = new Map()
    for (const item of bin) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
    const mixed = counts.size > 1
    const summary =
      bin.length === 1
        ? message.subject || t(message.type || 'Coordination message')
        : [...counts]
            .map(([type, count]) => `${number(count)} ${t(type || 'Coordination message')}`)
            .join(locale.startsWith('zh') || locale.startsWith('ja') ? '、' : ', ')
    const label = t('{from} to {to}, {time}: {summary}', {
      from: fromName,
      to: toName,
      time: eventTime.format(message.at),
      summary
    })
    const ids = bin.map((item) => item.id)
    if (selection?.message && ids.includes(selection.message)) {
      selection.key = 'message:' + message.id
      selection.messages = ids
    }
    const group = svg('g', {
      class: 'message-target',
      ...(input ? { 'data-agent': message.to } : { 'data-from': message.from }),
      'data-to': message.to,
      'data-x': at,
      role: 'button',
      tabindex: 0,
      'aria-label': label,
      'data-key': `message:${message.id}`,
      'data-message': message.id,
      'data-status': mixed ? 'Mixed' : message.type,
      'data-message-ids': JSON.stringify(ids)
    })
    group.append(svg('title', {}, label))
    if (input) {
      group.append(
        svg('circle', { cx: at, cy: to, r: 7, fill: 'transparent' }),
        svg('path', { d: `M ${at} ${to - 4} l 4 4 -4 4 -4 -4 Z`, class: 'mailbox-input' })
      )
    } else {
      if (!observedAt(message.to)) {
        group.append(
          svg('circle', {
            cx: from === to ? at + 2 : at,
            cy: from === to ? to + 12 : to,
            r: 4,
            class: 'unobserved-endpoint recipient'
          })
        )
      }
      group.append(
        svg('path', { d: path, class: 'message-hit' }),
        svg('path', { d: path, class: 'message-path', 'marker-end': 'url(#message-arrow)' }),
        svg('circle', {
          cx: at,
          cy: from === to ? from - 12 : from,
          r: fromObserved ? 2 : 4,
          class: fromObserved ? 'message-dot' : 'message-dot unobserved-endpoint'
        })
      )
    }
    if (bin.length > 1) {
      group.append(
        svg('text', { x: at + 3, y: (from + to) / 2, class: 'message-count' }, number(bin.length))
      )
    }
    chart.append(group)
  }
  laneMotion.apply(previousLanes, positions)
  renderDetail()
  if (activeKey && document.hasFocus()) {
    Array.from(document.querySelectorAll('[data-key]'))
      .find((element) => element.dataset.key === activeKey)
      ?.focus({ preventScroll: true })
  }
}

const detailInputs = new DetailInputs()

function renderDetail() {
  renderActivityDetail({
    selection,
    displayed,
    node,
    eventTime,
    stateOf,
    stateLabel,
    laneEvidence,
    duration: segmentDuration,
    unobservedDescription
  })
  detailInputs.select(
    $('detail').hidden || selection?.message
      ? null
      : displayed.agents.find((agent) => agent.id === selection?.agent),
    paused
  )
  if ($('detail').hidden) {
    $('detail').hidePopover()
  }
}

function inspect(target) {
  if (!displayed) {
    return
  }
  if (target.dataset.message) {
    selection = {
      key: target.dataset.key,
      message: target.dataset.message,
      messages: JSON.parse(target.dataset.messageIds || '[]')
    }
  } else {
    const agent = displayed.agents.find((item) => item.id === target.dataset.agent)
    if (agent && target.dataset.segment === undefined) {
      selection = { key: target.dataset.key, agent: agent.id }
    } else {
      const segment = agent?.segments[Number(target.dataset.segment)]
      if (!segment) {
        return
      }
      selection = { key: target.dataset.key, agent: agent.id, start: segment.start }
    }
  }
  $('copy-status').textContent = ''
  $('identity').open = false
  renderDetail()
  if (!$('detail').hidden) {
    $('detail').showPopover()
  }
  $('detail-heading').focus({ preventScroll: true })
}

function setConnection(state, label) {
  const status = $('live-status')
  const text = t(label)
  if (status.dataset.state === state && status.textContent === text) return
  status.dataset.label = label
  status.dataset.state = state
  status.textContent = text
}

function showViewStatus() {
  if (paused) setConnection('paused', 'View paused')
  else if (latest) setConnection('live', 'Live')
  else setConnection('updating', 'Updating…')
}

async function refresh() {
  if (disposed) {
    return
  }
  if (pending) {
    rerun = true
    return
  }
  pending = true
  $('retry').disabled = true
  try {
    if (!window.orca?.plugin?.request) {
      throw new Error('Open this panel in Orca with the Agents Director plugin enabled.')
    }
    const hideShortTasks = preferences.hideShortTasks
    let snapshot = await window.orca.plugin.request('activity.snapshot', {
      hideShortTasks,
      withOmittedActivity: true
    })
    if (hideShortTasks !== preferences.hideShortTasks) {
      rerun = true
      return
    }
    if (disposed) {
      return
    }
    if (
      !snapshot ||
      !Array.isArray(snapshot.agents) ||
      !Array.isArray(snapshot.messages) ||
      !Array.isArray(snapshot.sources) ||
      !Number.isFinite(snapshot.now) ||
      !Number.isFinite(snapshot.windowStart) ||
      !Number.isFinite(snapshot.collectingSince)
    ) {
      throw new Error('The activity source returned an invalid snapshot.')
    }
    if (snapshot.omissionToken) {
      const reply = await window.orca.plugin.request('activity.omittedActivity', {
        token: snapshot.omissionToken
      })
      if (reply.stale) {
        rerun = true
        return
      }
      const agents = [...snapshot.agents]
      for (const { index, ...evidence } of reply.rows)
        agents[index] = { ...agents[index], ...evidence }
      snapshot = { ...snapshot, agents }
    }
    if (snapshot.headingVersion) {
      let pinnedProjects = latest?.pinnedProjects
      if (latest?.headingVersion !== snapshot.headingVersion) {
        pinnedProjects = []
        for (let index = 0; ; index++) {
          const page = await window.orca.plugin.request('activity.projectHeadings', {
            version: snapshot.headingVersion,
            index
          })
          if (page.stale) {
            rerun = true
            return
          }
          pinnedProjects.push(...page.headings)
          if (!page.more) break
        }
      }
      snapshot = { ...snapshot, pinnedProjects }
    }
    if (snapshot.language && !snapshot.preferencesUnavailable)
      preferences.language = snapshot.language
    $('language').value = preferences.language
    const localeChanged = updateLocale(preferences.language)
    if (localeChanged) {
      localizeDocument()
      localizeActions()
    }
    updatePreferenceError(snapshot.preferencesUnavailable)
    latest = snapshot
    $('failure').hidden = true
    showViewStatus()
    if (!paused || !displayed || displayedHideShortTasks !== hideShortTasks) {
      displayedHideShortTasks = hideShortTasks
      displayed = latest
      render()
    } else if (
      displayed.pinVersion !== latest.pinVersion ||
      displayed.headingVersion !== latest.headingVersion
    ) {
      displayed = { ...latest, now: displayed.now, windowStart: displayed.windowStart }
      render()
    } else if (localeChanged) render()
  } catch (error) {
    if (updateLocale(preferences.language)) {
      localizeDocument()
      render()
    }
    lastError = error instanceof Error ? error.message : 'Could not read activity.'
    renderFailure()
  } finally {
    pending = false
    $('retry').disabled = false
    if (rerun && !disposed) {
      rerun = false
      void refresh()
    }
  }
}
let lastError
function renderFailure() {
  $('failure').hidden = false
  $('failure-text').textContent = [
    displayed && t('Showing the last received activity.'),
    t(lastError)
  ]
    .filter(Boolean)
    .join(' ')
  setConnection('error', 'Disconnected')
  if (!displayed) {
    setEmpty(
      t('Activity is unavailable'),
      t('Retry the connection, or check that the plugin worker is enabled.')
    )
  }
}

let preferenceError = null
function updatePreferenceError(unavailable = latest?.preferencesUnavailable) {
  const error = $('preference-error')
  error.hidden = !preferenceError && !unavailable
  error.textContent = error.hidden ? '' : t(preferenceError ?? 'Saved preferences are unavailable.')
}

async function changePreference(change) {
  try {
    const result = await window.orca.plugin.request('activity.changePreference', change)
    preferenceError = result?.saved
      ? null
      : result?.reason === 'pinLimit'
        ? 'This pin list is full. Unpin an item and try again.'
        : 'Could not save this preference. Try again.'
  } catch {
    preferenceError = 'Could not save this preference. Try again.'
  }
  updatePreferenceError()
  await refresh()
}

$('language').addEventListener('change', () => {
  void changePreference({ field: 'language', value: $('language').value })
})

$('hide-short-tasks').setAttribute('aria-pressed', String(preferences.hideShortTasks))
$('hide-short-tasks').addEventListener('click', () => {
  preferences.set({ hideShortTasks: !preferences.hideShortTasks })
  $('hide-short-tasks').setAttribute('aria-pressed', String(preferences.hideShortTasks))
  clearTimeout(gestureTimer)
  gestureAgents = null
  void refresh()
})
$('shorten-links').addEventListener('click', () => {
  preferences.set({ compactLanes: !preferences.compactLanes })
  render()
})
$('search').addEventListener('input', render)
$('retry').addEventListener('click', () => void refresh())
function localizeTick(tick, value) {
  tick.textContent = value === 24 ? unit(1, 'day', true) : windowLabel(value)
  tick.setAttribute(
    'aria-label',
    t('Set window to {duration}', { duration: duration(value * HOUR) })
  )
}
for (const value of [1 / 4, 1, 6, 24, 168]) {
  const tick = node('button', 'zoom-tick')
  tick.type = 'button'
  tick.hidden = true
  tick.dataset.hours = String(value)
  localizeTick(tick, value)
  tick.addEventListener('click', () => {
    preferences.set({ hours: Math.max(minHours, Math.min(value, maxHours)) })
    render()
  })
  $('zoom-ticks').append(tick)
}
$('zoom').addEventListener('input', () => {
  const fraction = Number($('zoom').value) / 1000
  hours =
    fraction === 1
      ? maxHours
      : fraction === 0
        ? minHours
        : minHours * (maxHours / minHours) ** fraction
  preferences.set({ hours }, true)
  render()
})
$('zoom').addEventListener('change', preferences.flush)
function setRange(start, end) {
  if (!displayed || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return
  }
  end = Math.min(displayed.now, end)
  start = Math.max(displayed.windowStart, start)
  if (end <= start) {
    return
  }
  hours = (end - start) / HOUR
  preferences.set({ hours }, true)
  viewEnd = end >= displayed.now ? null : end
  render()
}
for (const id of ['range-start', 'range-end']) {
  $(id).addEventListener('change', () =>
    setRange(Date.parse($('range-start').value), Date.parse($('range-end').value))
  )
}
function holdLanesDuringGesture() {
  if (!gestureAgents) {
    gestureAgents = renderedAgents
    laneMotion.cancel()
  }
  clearTimeout(gestureTimer)
  gestureTimer = setTimeout(() => {
    gestureAgents = null
    if (!disposed) {
      render()
    }
  }, 180)
}
$('chart-scroll').addEventListener(
  'wheel',
  (event) => {
    if (!displayed) {
      return
    }
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      Math.abs(event.deltaX) <= Math.abs(event.deltaY)
    ) {
      return
    }
    event.preventDefault()
    holdLanesDuringGesture()
    const end = viewEnd ?? displayed.now
    if (event.ctrlKey || event.metaKey) {
      const delta = Math.max(-100, Math.min(100, event.deltaY))
      const next = Math.max(minHours, Math.min(maxHours, hours * Math.exp(delta * 0.0015)))
      setRange(end - next * HOUR, end)
    } else {
      const delta = ((event.deltaX || event.deltaY) * hours * HOUR) / 600
      const boundedEnd = Math.min(
        displayed.now,
        Math.max(displayed.windowStart + hours * HOUR, end + delta)
      )
      setRange(boundedEnd - hours * HOUR, boundedEnd)
    }
  },
  { passive: false }
)
$('pause').addEventListener('click', () => {
  paused = !paused
  $('pause').textContent = t(paused ? 'Resume live' : 'Pause view')
  $('pause').setAttribute('aria-pressed', String(paused))
  if (!paused && latest) {
    displayed = latest
  }
  if ($('failure').hidden) {
    showViewStatus()
  }
  render()
})
$('lanes').addEventListener('click', (event) => {
  const button = event.target.closest('[data-pin]')
  if (button) {
    const { pin, pinKey } = button.dataset
    clearTimeout(gestureTimer)
    gestureAgents = null
    void changePreference({ field: pin, key: pinKey })
    return
  }
  const target = event.target.closest('[data-agent]')
  if (target) {
    inspect(target)
  }
})
$('chart').addEventListener('click', (event) => {
  const target = event.target.closest('[data-key]')
  if (target) {
    inspect(target)
  }
})
$('chart').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }
  const target = event.target.closest('[data-key]')
  if (target) {
    event.preventDefault()
    inspect(target)
  }
})
function closeDetail() {
  const previous = selection?.key
  selection = null
  renderDetail()
  Array.from(document.querySelectorAll('[data-key]'))
    .find((element) => element.dataset.key === previous)
    ?.focus({ preventScroll: true })
}
$('close-detail').addEventListener('click', closeDetail)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selection) {
    closeDetail()
  }
})
const viewportChanged = () =>
  $('chart-scroll').clientWidth !== renderedWidth ||
  $('chart-scroll').clientHeight !== renderedHeight ||
  $('zoom-ticks').clientWidth !== renderedZoomWidth
const resize = new ResizeObserver(() => {
  if (disposed || resizeFrame !== null || !viewportChanged()) {
    return
  }
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    if (!disposed && viewportChanged()) {
      render()
    }
  })
})
const localizeActions = installActivityActions(() => displayed)
resize.observe($('chart-scroll'))
resize.observe($('zoom-ticks'))
if (window.orca?.plugin?.on) {
  subscription = window.orca.plugin.on('activity.changed', () => void refresh())
}
const timer = window.setInterval(() => void refresh(), 5000)
window.addEventListener(
  'pagehide',
  () => {
    disposed = true
    window.clearInterval(timer)
    clearTimeout(gestureTimer)
    resize.disconnect()
    cancelAnimationFrame(resizeFrame)
    laneMotion.dispose()
    void preferences.flush()
    subscription?.dispose()
  },
  { once: true }
)
showViewStatus()
void refresh()
