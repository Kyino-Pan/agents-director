export function installActivityActions(getSnapshot) {
  const menu = document.getElementById('activity-menu')
  const navigate = document.getElementById('navigate-terminal')
  const sources = document.getElementById('sources-dialog')
  const feedback = document.getElementById('navigation-status')
  const mac = navigator.userAgent.includes('Mac')
  let selectedAgent
  let pending = false
  let returnFocus
  const hasAddress = (agent) =>
    agent?.terminalHandle || ((agent?.paneKey || agent?.sessionId) && agent?.workspace)
  const agentAt = (target) => {
    const id = target.closest('[data-agent]')?.dataset.agent
    return getSnapshot()?.agents.find((agent) => agent.id === id)
  }
  const jump = async (agent) => {
    if (pending) {
      return
    }
    pending = true
    feedback.hidden = false
    feedback.textContent = 'Opening agent…'
    try {
      if (!hasAddress(agent)) {
        throw new Error('No navigation address was recorded for this agent.')
      }
      const result = await window.orca.plugin.request('activity.navigate', { agentId: agent.id })
      if (!result?.navigated) {
        throw new Error('The agent could not be opened.')
      }
      feedback.hidden = true
    } catch (error) {
      feedback.textContent = error.message
    } finally {
      pending = false
    }
  }
  const openMenu = (target, x, y) => {
    selectedAgent = agentAt(target)
    returnFocus = target.closest('[data-agent]') || document.activeElement
    navigate.hidden = !selectedAgent
    navigate.textContent =
      selectedAgent?.sessionId &&
      (!selectedAgent.terminalHandle ||
        selectedAgent.paneKey?.startsWith('structured-agent-session-'))
        ? 'Go to Chat'
        : 'Go to terminal'
    navigate.disabled = !hasAddress(selectedAgent) || pending
    menu.showPopover()
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`
    menu.querySelector('button:not([hidden]):not(:disabled)')?.focus()
  }
  document.addEventListener('contextmenu', (event) => {
    if (event.target.closest('input, textarea, #sources-dialog')) {
      return
    }
    event.preventDefault()
    openMenu(event.target, event.clientX, event.clientY)
  })
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target)) {
      menu.hidePopover()
    }
  })
  window.addEventListener('blur', () => menu.hidePopover())
  document.addEventListener(
    'click',
    (event) => {
      const agent = agentAt(event.target)
      if (agent && (mac ? event.metaKey : event.ctrlKey)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void jump(agent)
      }
    },
    true
  )
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const bounds = event.target.getBoundingClientRect()
      openMenu(event.target, bounds.left, bounds.bottom)
    }
  })
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('button:not([hidden]):not(:disabled)')]
    const index = items.indexOf(document.activeElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      menu.hidePopover()
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        returnFocus?.focus({ preventScroll: true })
      }
    }
  })
  navigate.addEventListener('click', () => {
    menu.hidePopover()
    void jump(selectedAgent)
  })
  document.getElementById('show-sources').addEventListener('click', () => {
    menu.hidePopover()
    sources.showModal()
  })
  document.getElementById('close-sources').addEventListener('click', () => sources.close())
  sources.addEventListener('close', () => returnFocus?.focus({ preventScroll: true }))
  sources.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
    }
  })
}

export function renderSources(snapshot, node, dateFormat) {
  const $ = (id) => document.getElementById(id)
  const unavailable = snapshot.sources.filter((source) => source.status !== 'ok').length
  $('source-summary').textContent =
    `Data sources · ${unavailable ? `${unavailable} limited or unavailable` : 'available'}`
  $('source-list').replaceChildren(
    ...snapshot.sources.map((source) => {
      const row = node('div', 'source')
      const status = node('span', 'source-state', source.status)
      status.dataset.state = source.status
      row.append(node('strong', '', source.name), status, node('p', '', source.detail))
      return row
    })
  )
  $('collection-note').textContent =
    `Collecting since ${dateFormat.format(snapshot.collectingSince)}. Only observed activity is shown; empty time is not an inferred state.`
  $('notice').hidden = !snapshot.limited
  $('notice').textContent =
    'Some activity is unavailable. Right-click → Data sources for coverage details.'
}
