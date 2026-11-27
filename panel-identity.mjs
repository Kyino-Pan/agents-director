import { projectKey, terminalKey } from './pin-identity.mjs'
import { t, locale } from './panel-i18n.mjs'
import { segmentAt, hasWindowActivity } from './timeline-evidence.mjs'
import { orderProjectLanes } from './lane-order.mjs'
import { harnessLabel } from './panel-harness.mjs'

const $ = (id) => document.getElementById(id)

export const IDENTITY_FIELDS = [
  ['id', 'Agent ID'],
  ['provider', 'Harness'],
  ['sessionId', 'Session ID'],
  ['providerSessionId', 'Provider session'],
  ['paneKey', 'Pane key'],
  ['terminalHandle', 'Terminal handle'],
  ['runId', 'Run ID'],
  ['dispatchId', 'Dispatch ID'],
  ['taskId', 'Task ID'],
  ['workspace', 'Workspace']
]

const DETAIL_FIELDS = [
  ...IDENTITY_FIELDS,
  ['parentId', 'Parent agent'],
  ['projectId', 'Project ID']
]

export function agentName(agent) {
  return agent?.label?.trim() && agent.label !== agent.id && agent.labelSource !== 'fallback'
    ? agent.label
    : t('{provider} session', { provider: agent?.provider ? harnessLabel(agent) : t('Agent') })
}

export function renderIdentity(agents, node, displayed) {
  const signature = JSON.stringify(
    agents.map((agent) => [
      locale,
      agent.label,
      ...DETAIL_FIELDS.map(([key]) => agent[key]),
      displayed.agents.find((item) => item.id === agent.parentId)?.label
    ])
  )
  if ($('identity-list').dataset.identity === signature) {
    return
  }
  $('identity-list').dataset.identity = signature
  $('copy-status').textContent = ''
  for (const [target, entries, core] of [
    ['identity-list', IDENTITY_FIELDS.slice(0, 2), true],
    ['identity-more', DETAIL_FIELDS.slice(2), false]
  ]) {
    $(target).replaceChildren(
      ...agents.map((agent) => {
        const section = node('div', 'identity-agent')
        const header = node('div', 'identity-heading')
        if (agents.length > 1) header.append(node('strong', '', agentName(agent)))
        if (core) {
          const copy = node('button', '', t('Copy agent ID'))
          copy.type = 'button'
          copy.dataset.copyId = agent.id
          header.append(copy)
        }
        const fields = node('dl')
        for (const [key, label] of entries) {
          let text = key === 'provider' ? harnessLabel(agent) : agent[key]
          if (key === 'parentId' && text) {
            const parent = displayed.agents.find((item) => item.id === text)
            text = parent
              ? `${agentName(parent)} · ${text}`
              : t('{id} (outside this snapshot)', { id: text })
          }
          if (text) {
            const value = node('dd', '', text)
            if (key === 'id') value.dataset.identityId = agent.id
            fields.append(node('dt', '', t(label)), value)
          }
        }
        section.append(header, fields)
        return section
      })
    )
  }
}

$('identity-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-id]')
  if (!button) {
    return
  }
  const id = button.dataset.copyId
  try {
    await navigator.clipboard.writeText(id)
    $('copy-status').textContent = t('Agent ID copied.')
  } catch {
    const value = Array.from($('identity-list').querySelectorAll('[data-identity-id]')).find(
      (item) => item.dataset.identityId === id
    )
    if (value) {
      window.getSelection()?.selectAllChildren(value)
    }
    $('copy-status').textContent = t(
      'Clipboard unavailable. Agent ID selected; copy it with your keyboard or context menu.'
    )
  }
})

export function renderActivityDetail(context) {
  const {
    selection,
    displayed,
    node,
    eventTime,
    stateOf,
    stateLabel,
    laneEvidence,
    duration,
    unobservedDescription
  } = context
  for (const target of document.querySelectorAll('[data-key]')) {
    target.dataset.selected = String(target.dataset.key === selection?.key)
  }
  if (!selection || !displayed) {
    $('detail').hidden = true
    return
  }
  $('detail').hidden = false
  if (selection.message) {
    const message = displayed.messages.find((item) => item.id === selection.message)
    if (!message) {
      $('detail').hidden = true
      return
    }
    const lane = (id) => displayed.agents.find((agent) => agent.id === id)
    let missingState = false
    const endpoint = (id, at) => {
      const state = stateOf(segmentAt(lane(id)?.segments ?? [], at))
      if (state !== 'unknown') return stateLabel(state)
      missingState = true
      return t('No observed state')
    }
    const input = message.from === null
    const received = Number.isFinite(message.deliveredAt)
    const recipient = agentName(lane(message.to))
    const route = input
      ? t('Received by {name}', { name: recipient })
      : agentName(lane(message.from)) + ' → ' + recipient
    $('detail-heading').textContent = message.subject || t(message.type || 'Coordination message')
    $('detail-meta').textContent = [route, t(message.type)].filter(Boolean).join(' · ')
    const states = input
      ? [
          t('At retrieval ({time}) · Receiver: {state}', {
            time: eventTime.format(message.at),
            state: endpoint(message.to, message.at)
          })
        ]
      : [
          t('At send ({time}) · Sender: {from} · Receiver: {to}', {
            time: eventTime.format(message.at),
            from: endpoint(message.from, message.at),
            to: endpoint(message.to, message.at)
          }),
          received
            ? t('At retrieval ({time}) · Receiver: {state}', {
                time: eventTime.format(message.deliveredAt),
                state: endpoint(message.to, message.deliveredAt)
              })
            : t('Delivery not confirmed')
        ]
    if (missingState) states.push(t('Execution state requires a separate recorder observation.'))
    const body =
      message.body ||
      t(
        message.id.startsWith('public-') ? 'Only routing metadata is recorded.' : 'No message body.'
      )
    $('detail-body').textContent = [...states, body].join('\n')
    const relatedIds = new Set(selection.messages)
    const related = displayed.messages.filter((item) => relatedIds.has(item.id))
    $('related-messages').replaceChildren(
      ...related.map((item) => {
        const button = node(
          'button',
          '',
          `${eventTime.format(item.at)} · ${item.subject || t(item.type || 'Coordination message')}`
        )
        button.type = 'button'
        button.addEventListener('click', () => {
          selection.message = item.id
          renderActivityDetail(context)
        })
        return button
      })
    )
    $('related-messages').hidden = related.length < 2
    renderIdentity(
      [...new Set([message.from, message.to])]
        .filter(Boolean)
        .map((id) => displayed.agents.find((agent) => agent.id === id) || { id }),
      node,
      displayed
    )
  } else {
    $('related-messages').hidden = true
    const agent = displayed.agents.find((item) => item.id === selection.agent)
    const segment = agent?.segments.find((item) => item.start === selection.start)
    if (!agent || (selection.start !== undefined && !segment)) {
      $('detail').hidden = true
      return
    }
    renderIdentity([agent], node, displayed)
    if (!segment) {
      $('detail-heading').textContent = agentName(agent)
      const evidence = laneEvidence.get(agent.id)
      $('detail-meta').textContent = evidence?.label ?? ''
      $('detail-body').textContent = evidence?.detail ?? ''
      return
    }
    const state = stateOf(segment)
    $('detail-heading').textContent = `${agentName(agent)} · ${stateLabel(state)}`
    $('detail-meta').textContent =
      `${eventTime.format(segment.start)} – ${eventTime.format(segment.end)} · ${duration(segment.end - segment.start)}`
    $('detail-body').textContent = t('Observed via {source}.', {
      source: t(segment.source || 'an unknown source')
    })
    if (state === 'unknown') {
      $('detail-body').textContent = unobservedDescription(agent, segment)
    }
  }
}

export function overlapsOmittedRange(agent, start, end) {
  return agent.omittedRanges?.some((range) => range.start < end && range.end > start)
}

export function windowActivity(snapshot, start, end) {
  const ids = new Set()
  for (const message of snapshot.messages) {
    if (message.at >= start && message.at <= end) {
      ids.add(message.to)
      if (message.from) ids.add(message.from)
    }
  }
  for (const agent of snapshot.agents) {
    if (Number.isFinite(agent.spawnedAt) && agent.spawnedAt >= start && agent.spawnedAt <= end) {
      ids.add(agent.id)
      if (agent.parentId) ids.add(agent.parentId)
    }
    if (hasWindowActivity(agent, start, end)) ids.add(agent.id)
  }
  return ids
}

export function activeAgents(
  snapshot,
  start,
  end,
  pins = new Set(),
  activity = windowActivity(snapshot, start, end)
) {
  const query = $('search').value.trim().toLocaleLowerCase(locale)
  return snapshot.agents.filter(
    (agent) =>
      (pins.has(terminalKey(agent)) || (!agent.pinnedShortTask && activity.has(agent.id))) &&
      [
        agentName(agent),
        agent.label,
        agent.projectName,
        agent.workspace,
        agent.provider,
        ...IDENTITY_FIELDS.map(([key]) => agent[key])
      ].some((value) =>
        String(value || '')
          .toLocaleLowerCase(locale)
          .includes(query)
      )
  )
}

export function visibleAgents(snapshot, start, end, compact = false, pins, activity) {
  const agents = activeAgents(snapshot, start, end, pins, activity)
  const ids = new Set(agents.map((agent) => agent.id))
  const children = new Map()
  for (const agent of agents) {
    const parent = ids.has(agent.parentId) ? agent.parentId : null
    if (!children.has(parent)) {
      children.set(parent, [])
    }
    children.get(parent).push(agent)
  }
  const ordered = []
  const visited = new Set()
  function visit(agent) {
    if (visited.has(agent.id)) {
      return
    }
    visited.add(agent.id)
    ordered.push(agent)
    for (const child of children.get(agent.id) || []) {
      visit(child)
    }
  }
  for (const agent of children.get(null) || []) {
    visit(agent)
  }
  for (const agent of agents) {
    visit(agent)
  }
  const groups = new Map()
  for (const agent of ordered) {
    const key = projectKey(agent)
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(agent)
  }
  if (!groups.size) {
    return []
  }
  const projectByAgent = new Map(agents.map((agent) => [agent.id, projectKey(agent)]))
  const weights = new Map()
  for (const message of snapshot.messages) {
    const from = projectByAgent.get(message.from)
    const to = projectByAgent.get(message.to)
    if (from === undefined || to === undefined || from === to) {
      continue
    }
    for (const [a, b] of [
      [from, to],
      [to, from]
    ]) {
      if (!weights.has(a)) {
        weights.set(a, new Map())
      }
      weights.get(a).set(b, (weights.get(a).get(b) || 0) + 1)
    }
  }
  const remaining = [...groups.keys()]
  const result = [remaining.shift()]
  while (remaining.length) {
    let choice = 0
    let prepend = false
    let best = 0
    for (let i = 0; i < remaining.length; i++) {
      const left = weights.get(remaining[i])?.get(result[0]) || 0
      const right = weights.get(remaining[i])?.get(result.at(-1)) || 0
      if (Math.max(left, right) > best) {
        best = Math.max(left, right)
        choice = i
        prepend = left > right
      }
    }
    const [next] = remaining.splice(choice, 1)
    if (prepend) {
      result.unshift(next)
    } else {
      result.push(next)
    }
  }
  return orderProjectLanes(
    result.flatMap((key) => groups.get(key)),
    snapshot.messages,
    start,
    end,
    compact
  )
}
