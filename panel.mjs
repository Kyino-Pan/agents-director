import { activeAgents, agentName, renderActivityDetail, visibleAgents } from './panel-identity.mjs'
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
const locale = window.orca?.locale || navigator.language
const timeFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
const dayHourFormat = new Intl.DateTimeFormat(locale, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit'
})
const dateFormat = new Intl.DateTimeFormat(locale, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})
let latest = null
let displayed = null
let displayedHideShortTasks = null
const preferences = await loadViewPreferences()
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
let renderedAgents = []
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
  return state === 'unknown' ? 'Unobserved' : state[0].toUpperCase() + state.slice(1)
}

function windowLabel(value) {
  if (value > 24 && value % 24 === 0) {
    return `${value / 24}d`
  }
  return duration(value * HOUR)
    .replace(' min', 'm')
    .replace('h 0m', 'h')
}

function renderZoom(snapshot) {
  maxHours = Math.min(168, Math.max(1 / 60, (snapshot.now - snapshot.windowStart) / HOUR))
  minHours = Math.min(1 / 12, maxHours)
  hours = Math.min(preferences.hours, maxHours)
  const fraction =
    maxHours === minHours ? 0 : Math.log(hours / minHours) / Math.log(maxHours / minHours)
  $('zoom').max = '1000'
  $('zoom').value = String(Math.round(fraction * 1000))
  $('zoom').setAttribute('aria-valuetext', `${duration(hours * HOUR)} of observed history`)
  $('zoom-min').textContent = windowLabel(minHours)
  $('zoom-limit').textContent = windowLabel(maxHours)
  $('zoom-value').textContent = windowLabel(hours)
}

function unobservedDescription(agent, segment) {
  const previous = agent.segments.findLast(
    (item) => item.end <= (segment?.start ?? Infinity) && stateOf(item) !== 'unknown'
  )
  return `No reliable state observation covers this interval. Missing or stale logs cannot confirm continued work.${previous ? `\nLast observed: ${stateLabel(stateOf(previous))} through ${dateFormat.format(previous.end)}.` : '\nNo earlier state observation is available in this snapshot.'}`
}

function duration(ms) {
  if (ms < 60_000) {
    return '< 1 min'
  }
  const minutes = Math.floor(ms / 60_000)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function setEmpty(title, body) {
  $('empty').replaceChildren(node('strong', '', title), node('p', '', body))
  $('empty').hidden = false
  $('chart-scroll').hidden = true
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
  const active = gestureAgents
    ? activeAgents(snapshot, start, end)
    : visibleAgents(snapshot, start, end, preferences.compactLanes)
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
  const agents = gestureAgents
    ? gestureAgents.map((agent) => currentAgents.get(agent.id) ?? agent)
    : active
  renderedAgents = agents
  const rowById = new Map(agents.map((agent, index) => [agent.id, index]))
  const positions = new Map()
  const headings = []
  let height = 0
  let previousProject
  for (const agent of agents) {
    const project = agent.projectId || '__unknown__'
    if (project !== previousProject) {
      headings.push({ y: height, name: agent.projectName || 'Project unavailable' })
      height += GROUP
      previousProject = project
    }
    positions.set(agent.id, height + ROW / 2)
    height += ROW
  }
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
  const messages = snapshot.messages.filter(
    (message) =>
      message.at >= start &&
      message.at <= end &&
      rowById.has(message.from) &&
      rowById.has(message.to)
  )
  if (
    selection &&
    ((selection.agent && !rowById.has(selection.agent)) ||
      (selection.message && !messages.some((message) => message.id === selection.message)))
  ) {
    selection = null
  }
  $('summary').textContent =
    `${active.length} of ${snapshot.agents.length} agents · ${messages.length} coordination messages`
  $('period').textContent = `${dateFormat.format(start)} – ${dateFormat.format(end)}`
  renderSources(snapshot, node, dateFormat)
  $('view-empty').hidden = active.length > 0
  if (!snapshot.agents.length) {
    $('lanes').replaceChildren()
    $('chart').replaceChildren()
    $('axis').replaceChildren()
    setEmpty(
      snapshot.hiddenShortTasks ? 'Short tasks are hidden' : 'No activity observed yet',
      snapshot.hiddenShortTasks
        ? `${snapshot.hiddenShortTasks} finished ${snapshot.hiddenShortTasks === 1 ? 'task has' : 'tasks have'} less than 3 minutes of reliably observed execution. Turn off Hide short tasks (< 3 min) to show them.`
        : 'Start an Orca agent to see its activity here. Check Data sources if an existing agent is missing.'
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
  let lastProject
  for (const agent of agents) {
    const project = agent.projectId || '__unknown__'
    if (project !== lastProject) {
      labels.push(node('div', 'project-heading', agent.projectName || 'Project unavailable'))
      lastProject = project
    }
    const lane = node('button', 'lane')
    lane.type = 'button'
    lane.dataset.key = `agent:${agent.id}`
    lane.dataset.agent = agent.id
    const last = agent.segments.findLast((segment) => segment.start <= end)
    const state = stateOf(last)
    const label = agentName(agent)
    const identity = `${harnessLabel(agent)} · ${shortAgentId(agent)}`
    lane.setAttribute('aria-label', `${label}: ${stateLabel(state)}. ${identity}. Inspect agent`)
    const status = node('span', `lane-state ${state}`, stateLabel(state))
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
        ? (memory.bytes / 1024 ** 3).toFixed(1)
        : Math.round(memory.bytes / 1024 ** 2)
      const text = `${value} ${gib ? 'GiB' : 'MiB'}`
      const description = `Live terminal and child processes: ${text} (${memory.metric}), sampled ${new Date(memory.collectedAt).toLocaleTimeString()}`
      const badge = node('span', 'lane-memory', text)
      badge.title = description
      heading.append(badge)
      lane.setAttribute('aria-label', `${lane.getAttribute('aria-label')}. ${description}`)
    }
    lane.append(heading, meta)
    labels.push(lane)
  }
  $('lanes').replaceChildren(...labels)
  const chart = $('chart')
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`)
  chart.style.height = `${height}px`
  const defs = svg('defs')
  const marker = svg('marker', {
    id: 'message-arrow',
    viewBox: '0 0 8 8',
    refX: 7,
    refY: 4,
    markerWidth: 6,
    markerHeight: 6,
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
  defs.append(marker)
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
    agent.segments.forEach((segment, index) => {
      if (segment.end <= start || segment.start >= end) {
        return
      }
      const left = x(Math.max(start, segment.start))
      const barWidth = Math.max(0, x(Math.min(end, segment.end)) - left)
      const state = stateOf(segment)
      const key = `segment:${agent.id}:${segment.start}:${index}`
      const label = `${agentName(agent)}: ${stateLabel(state)}, ${dateFormat.format(segment.start)} to ${timeFormat.format(segment.end)}, ${duration(segment.end - segment.start)}`
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
          y: center(agent.id) - (state === 'unknown' ? 1 : 3),
          width: barWidth,
          height: state === 'unknown' ? 2 : 6,
          rx: 1,
          class: `segment ${state}${segment.end >= end ? ' current' : ''}`
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
    const from = center(message.from)
    const to = center(message.to)
    const path = messagePath(at, from, to)
    const fromName = agentName(agents[rowById.get(message.from)])
    const toName = agentName(agents[rowById.get(message.to)])
    const label = `${fromName} to ${toName}, ${timeFormat.format(message.at)}: ${message.subject || message.type}`
    const group = svg('g', {
      class: 'message-target',
      'data-from': message.from,
      'data-to': message.to,
      'data-x': at,
      role: 'button',
      tabindex: 0,
      'aria-label': label,
      'data-key': `message:${message.id}`,
      'data-message': message.id,
      'data-message-ids': JSON.stringify(bin.map((item) => item.id))
    })
    group.append(
      svg('title', {}, label),
      svg('path', { d: path, class: 'message-hit' }),
      svg('path', { d: path, class: 'message-path', 'marker-end': 'url(#message-arrow)' }),
      svg('circle', { cx: at, cy: from === to ? from - 12 : from, r: 2, class: 'message-dot' })
    )
    if (bin.length > 1) {
      group.append(
        svg('text', { x: at + 3, y: (from + to) / 2, class: 'message-count' }, String(bin.length))
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

function renderDetail() {
  renderActivityDetail({
    selection,
    displayed,
    node,
    timeFormat,
    dateFormat,
    stateOf,
    stateLabel,
    duration,
    unobservedDescription
  })
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
  $('identity').open = !selection.message && selection.start === undefined
  renderDetail()
  if (!$('detail').hidden) {
    $('detail').showPopover()
  }
  $('detail-heading').focus({ preventScroll: true })
}

function setConnection(state, label) {
  $('live-status').dataset.state = state
  $('live-status').textContent = label
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
    const snapshot = await window.orca.plugin.request('activity.snapshot', { hideShortTasks })
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
    latest = snapshot
    $('failure').hidden = true
    setConnection(paused ? 'paused' : 'live', paused ? 'View paused' : 'Live · 5s')
    if (!paused || !displayed || displayedHideShortTasks !== hideShortTasks) {
      displayedHideShortTasks = hideShortTasks
      displayed = latest
      render()
    }
  } catch (error) {
    $('failure').hidden = false
    $('failure-text').textContent =
      `${displayed ? 'Showing the last received activity. ' : ''}${error instanceof Error ? error.message : 'Could not read activity.'}`
    setConnection('error', 'Disconnected')
    if (!displayed) {
      setEmpty(
        'Activity is unavailable',
        'Retry the connection, or check that the plugin worker is enabled.'
      )
    }
  } finally {
    pending = false
    $('retry').disabled = false
    if (rerun && !disposed) {
      rerun = false
      void refresh()
    }
  }
}

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
  $('pause').textContent = paused ? 'Resume live' : 'Pause view'
  $('pause').setAttribute('aria-pressed', String(paused))
  if (!paused && latest) {
    displayed = latest
  }
  if ($('failure').hidden) {
    setConnection(paused ? 'paused' : 'live', paused ? 'View paused' : 'Live · 5s')
  }
  render()
})
$('lanes').addEventListener('click', (event) => {
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
  $('chart-scroll').clientHeight !== renderedHeight
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
installActivityActions(() => displayed)
resize.observe($('chart-scroll'))
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
void refresh()
