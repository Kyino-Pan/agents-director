import { orderProjectLanes } from './lane-order.mjs'

const $ = (id) => document.getElementById(id)

export const IDENTITY_FIELDS = [
  ['id', 'Agent ID'],
  ['sessionId', 'Session ID'],
  ['providerSessionId', 'Provider session'],
  ['paneKey', 'Pane key'],
  ['terminalHandle', 'Terminal handle'],
  ['runId', 'Run ID'],
  ['dispatchId', 'Dispatch ID'],
  ['taskId', 'Task ID'],
  ['workspace', 'Workspace']
]

export function agentName(agent) {
  return agent?.label?.trim() && agent.label !== agent.id ? agent.label : 'Unnamed agent'
}

export function renderIdentity(agents, node) {
  const signature = JSON.stringify(
    agents.map((agent) => [agent.label, ...IDENTITY_FIELDS.map(([key]) => agent[key])])
  )
  if ($('identity-list').dataset.identity === signature) {
    return
  }
  $('identity-list').dataset.identity = signature
  $('copy-status').textContent = ''
  $('identity-list').replaceChildren(
    ...agents.map((agent) => {
      const section = node('div', 'identity-agent')
      const header = node('div', 'identity-heading')
      const copy = node('button', '', 'Copy agent ID')
      copy.type = 'button'
      copy.dataset.copyId = agent.id
      if (agents.length > 1) {
        header.append(node('strong', '', agentName(agent)))
      }
      header.append(copy)
      const fields = node('dl')
      for (const [key, label] of IDENTITY_FIELDS) {
        if (agent[key]) {
          const value = node('dd', '', agent[key])
          if (key === 'id') {
            value.dataset.identityId = agent.id
          }
          fields.append(node('dt', '', label), value)
        }
      }
      section.append(header, fields)
      return section
    })
  )
}

$('identity-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-id]')
  if (!button) {
    return
  }
  const id = button.dataset.copyId
  try {
    await navigator.clipboard.writeText(id)
    $('copy-status').textContent = 'Agent ID copied.'
  } catch {
    const value = Array.from($('identity-list').querySelectorAll('[data-identity-id]')).find(
      (item) => item.dataset.identityId === id
    )
    if (value) {
      window.getSelection()?.selectAllChildren(value)
    }
    $('copy-status').textContent =
      'Clipboard unavailable. Agent ID selected; copy it with your keyboard or context menu.'
  }
})

export function renderActivityDetail(context) {
  const {
    selection,
    displayed,
    node,
    timeFormat,
    dateFormat,
    stateOf,
    stateLabel,
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
    const name = (id) => agentName(displayed.agents.find((agent) => agent.id === id))
    $('detail-heading').textContent = message.subject || message.type || 'Coordination message'
    $('detail-meta').textContent =
      `${name(message.from)} → ${name(message.to)} · ${message.type} · ${dateFormat.format(message.at)}${message.deliveredAt ? ` · Delivered ${timeFormat.format(message.deliveredAt)}` : ' · Delivery not confirmed'}`
    $('detail-body').textContent = message.body || 'No message body.'
    const related = selection.messages || []
    $('related-messages').replaceChildren(
      ...related.map((id) => {
        const item = displayed.messages.find((entry) => entry.id === id)
        const button = node(
          'button',
          '',
          `${timeFormat.format(item.at)} · ${item.subject || item.type}`
        )
        button.type = 'button'
        button.addEventListener('click', () => {
          selection.message = id
          renderActivityDetail(context)
        })
        return button
      })
    )
    $('related-messages').hidden = related.length < 2
    renderIdentity(
      [...new Set([message.from, message.to])].map(
        (id) => displayed.agents.find((agent) => agent.id === id) || { id }
      ),
      node
    )
  } else {
    $('related-messages').hidden = true
    const agent = displayed.agents.find((item) => item.id === selection.agent)
    const segment = agent?.segments.find((item) => item.start === selection.start)
    if (!agent || (selection.start !== undefined && !segment)) {
      $('detail').hidden = true
      return
    }
    renderIdentity([agent], node)
    if (!segment) {
      $('detail-heading').textContent = agentName(agent)
      $('detail-meta').textContent = [agent.provider, agent.workspace].filter(Boolean).join(' · ')
      $('detail-body').textContent = agent.parentId
        ? `Child of ${agentName(displayed.agents.find((item) => item.id === agent.parentId))}`
        : 'Agent identity and observed activity.'
      const last = agent.segments.at(-1)
      if (stateOf(last) === 'unknown') {
        $('detail-body').textContent = unobservedDescription(agent, last)
      }
      return
    }
    const state = stateOf(segment)
    $('detail-heading').textContent = `${agentName(agent)} · ${stateLabel(state)}`
    $('detail-meta').textContent =
      `${dateFormat.format(segment.start)} – ${dateFormat.format(segment.end)} · ${duration(segment.end - segment.start)}`
    $('detail-body').textContent =
      `Observed via ${segment.source || 'an unknown source'}.\n${agent.workspace || 'Workspace unavailable'}${agent.parentId ? `\nParent agent: ${agentName(displayed.agents.find((item) => item.id === agent.parentId))}` : ''}`
    if (state === 'unknown') {
      $('detail-body').textContent = unobservedDescription(agent, segment)
    }
  }
}

export function visibleAgents(snapshot, start, end, compact = false) {
  const participants = new Set(
    snapshot.messages.flatMap((message) =>
      message.at >= start && message.at <= end ? [message.from, message.to] : []
    )
  )
  const query = $('search').value.trim().toLocaleLowerCase()
  const agents = snapshot.agents.filter(
    (agent) =>
      (participants.has(agent.id) ||
        (Number.isFinite(agent.spawnedAt) && agent.spawnedAt >= start && agent.spawnedAt <= end) ||
        agent.segments.some((segment) =>
          segment.state === 'done'
            ? segment.start >= start && segment.start <= end
            : ['working', 'blocked', 'waiting'].includes(segment.state) &&
              segment.end > start &&
              segment.start < end
        )) &&
      [
        agent.label,
        agent.projectName,
        agent.workspace,
        agent.provider,
        ...IDENTITY_FIELDS.map(([key]) => agent[key])
      ].some((value) =>
        String(value || '')
          .toLocaleLowerCase()
          .includes(query)
      )
  )
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
    const key = agent.projectId || '__unknown__'
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(agent)
  }
  if (!groups.size) {
    return []
  }
  const projectByAgent = new Map(
    agents.map((agent) => [agent.id, agent.projectId || '__unknown__'])
  )
  const weights = new Map()
  for (const message of snapshot.messages) {
    const from = projectByAgent.get(message.from)
    const to = projectByAgent.get(message.to)
    if (!from || !to || from === to) {
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
