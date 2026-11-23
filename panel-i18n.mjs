import fr from './locales/fr.mjs'
import de from './locales/de.mjs'
import ja from './locales/ja.mjs'
import ko from './locales/ko.mjs'
import zh from './locales/zh.mjs'

const catalogs = { de, en: {}, fr, ja, ko, zh }
export let locale = 'en'
let catalog = catalogs.en
const formats = new Map()

export function resolveLocale(hostLocale, browserLocales) {
  for (const tag of [hostLocale, ...browserLocales]) {
    if (typeof tag !== 'string' || !tag) continue
    try {
      const candidate = new Intl.Locale(tag)
      if (Object.hasOwn(catalogs, candidate.language)) return candidate.toString()
      // A valid explicit Orca locale takes precedence over a different OS language.
      if (tag === hostLocale) return 'en'
    } catch {
      // Ignore invalid host or browser preferences and try the next tag.
    }
  }
  return 'en'
}

export function updateLocale(preference = 'auto') {
  const tag =
    preference !== 'auto'
      ? preference
      : resolveLocale(
          window.orca?.locale,
          navigator.languages?.length ? navigator.languages : [navigator.language]
        )
  const changed = tag !== locale
  locale = tag
  document.documentElement.lang = tag
  catalog = catalogs[new Intl.Locale(tag).language]
  if (changed) formats.clear()
  return changed
}

// Keys are the English defaults. Interpolate once so arbitrary user text stays literal.
export function t(key, values) {
  const template = Object.hasOwn(catalog, key) ? catalog[key] : key
  return values ? template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match) : template
}

function formatter(Format, options) {
  const key = Format.name + JSON.stringify(options)
  if (!formats.has(key)) formats.set(key, new Format(locale, options))
  return formats.get(key)
}

export const number = (value, options) => formatter(Intl.NumberFormat, options).format(value)
export const date = (value, options) => formatter(Intl.DateTimeFormat, options).format(value)
export const unit = (value, name, compact = false) => {
  if (catalog === catalogs.en) {
    const suffix = {
      day: 'd',
      hour: 'h',
      minute: compact ? 'm' : ' min',
      second: ' s',
      millisecond: ' ms'
    }
    return number(value) + suffix[name]
  }
  return number(value, { style: 'unit', unit: name, unitDisplay: compact ? 'narrow' : 'short' })
}

// Capture only the shipped document, before rendering any host-provided labels or messages.
// Direct text nodes leave legend swatches, the SVG hatch and nested controls in place.
export function bindDocumentText(root) {
  const bindings = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const key = node.nodeValue.trim()
    if (Object.hasOwn(zh, key))
      bindings.push(() => {
        node.nodeValue = t(key)
      })
  }
  for (const el of root.querySelectorAll(
    '[title], [aria-label], [placeholder], [aria-valuetext]'
  )) {
    for (const attr of ['title', 'aria-label', 'placeholder', 'aria-valuetext']) {
      const key = el.getAttribute(attr)
      if (key && Object.hasOwn(zh, key)) bindings.push(() => el.setAttribute(attr, t(key)))
    }
  }
  return () => {
    for (const apply of bindings) apply()
  }
}
