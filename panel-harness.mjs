import { t } from './panel-i18n.mjs'
import { harnessIcons } from './assets/orca-harness-icons.mjs'

let iconSequence = 0

function harnessEntry(agent) {
  const key = agent?.provider?.toLowerCase()
  return Object.hasOwn(harnessIcons, key) ? harnessIcons[key] : undefined
}

export function harnessLabel(agent) {
  return harnessEntry(agent)?.label ?? agent?.provider ?? t('Unknown harness')
}

export function shortAgentId(agent) {
  return (agent?.providerSessionId || agent?.sessionId || agent?.id || '')
    .split(':')
    .at(-1)
    .slice(-8)
}

export function harnessIcon(agent) {
  const icon = document.createElement('span')
  icon.className = 'harness-icon'
  icon.dataset.harness = agent?.provider || 'unknown'
  icon.setAttribute('role', 'img')
  icon.setAttribute('aria-label', harnessLabel(agent))
  const entry = harnessEntry(agent)
  if (entry) {
    // Only bundled Orca artwork is markup; agent names and unknown providers remain plain text.
    const prefix = `harness-${++iconSequence}-`
    icon.innerHTML = entry.markup
      .replace(/id="([^"]+)"/g, `id="${prefix}$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
  } else {
    icon.textContent = '?'
  }
  return icon
}
