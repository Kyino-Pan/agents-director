import { t, number } from './panel-i18n.mjs'
import { navigationUnavailableReason } from './navigation-identity.mjs'

export function installActivityActions(getSnapshot) {
  const menu = document.getElementById('activity-menu')
  const navigate = document.getElementById('navigate-terminal')
  const sources = document.getElementById('sources-dialog')
  const feedback = document.getElementById('navigation-status')
  const mac = navigator.userAgent.includes('Mac')
  let selectedAgent
  let feedbackKey
  let pending = false
  let returnFocus
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
    feedbackKey = 'Opening agent…'
    feedback.textContent = t(feedbackKey)
    try {
      const reason = navigationUnavailableReason(agent)
      if (reason) throw new Error(reason)
      const result = await window.orca.plugin.request('activity.navigate', { agentId: agent.id })
      if (!result?.navigated) {
        throw new Error('The agent could not be opened.')
      }
      feedback.hidden = true
    } catch (error) {
      feedbackKey = error.message
      feedback.textContent = t(feedbackKey)
    } finally {
      pending = false
    }
  }
  const openMenu = (target, x, y) => {
    selectedAgent = agentAt(target)
    returnFocus = target.closest('[data-agent]') || document.activeElement
    navigate.hidden = !selectedAgent
    const reason = navigationUnavailableReason(selectedAgent)
    navigate.textContent = t(reason || 'Open or resume terminal')
    navigate.disabled = pending || Boolean(reason)
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
  return () => {
    if (!feedback.hidden && feedbackKey) feedback.textContent = t(feedbackKey)
    if (selectedAgent)
      navigate.textContent = t(
        navigationUnavailableReason(selectedAgent) || 'Open or resume terminal'
      )
  }
}

export function renderSources(snapshot, node, dateFormat) {
  const $ = (id) => document.getElementById(id)
  const unavailable = snapshot.sources.filter((source) => source.status !== 'ok').length
  $('source-summary').textContent =
    `${t('Data sources')} · ${unavailable ? t('{count} limited or unavailable', { count: number(unavailable) }) : t('available')}`
  $('source-list').replaceChildren(
    ...snapshot.sources.map((source) => {
      const row = node('div', 'source')
      const status = node('span', 'source-state', t(source.status))
      status.dataset.state = source.status
      const agentSource = source.name.startsWith('Agents · ')
      const name = agentSource
        ? t('Agents · {id}', { id: source.name.slice('Agents · '.length) })
        : t(source.name)
      const suffix = ': current agents read through the public API.'
      const invalidList = ': Invalid agent list'
      const detail =
        agentSource && source.status === 'error' && source.detail?.endsWith(invalidList)
          ? source.detail.slice(0, -invalidList.length) + ': ' + t('Invalid agent list')
          : agentSource && source.status === 'ok' && source.detail?.endsWith(suffix)
            ? t('{workspace}: current agents read through the public API.', {
                workspace: source.detail.slice(0, -suffix.length)
              })
            : t(source.detail)
      row.append(node('strong', '', name), status, node('p', '', detail))
      return row
    })
  )
  $('collection-note').textContent = t(
    'Collecting since {time}. Only observed activity is shown; empty time is not an inferred state.',
    { time: dateFormat.format(snapshot.collectingSince) }
  )
  $('notice').hidden = !snapshot.limited
  $('notice').textContent = t(
    'Some activity is unavailable. Right-click → Data sources for coverage details.'
  )
}
