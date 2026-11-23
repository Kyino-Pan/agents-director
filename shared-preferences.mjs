// One worker serializes changes from every panel and editor. Only membership of
// displayed identities and the language cross the frame bridge.
export const languages = ['auto', 'zh', 'ja', 'ko', 'en', 'fr', 'de']
const keys = {
  language: 'view:language',
  pinnedProjects: 'view:pinned-projects',
  pinnedTerminals: 'view:pinned-terminals'
}

function savedPins(value) {
  if (value == null) return new Set()
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length))
    throw new Error('Invalid saved pins')
  return new Set(value)
}

export function createSharedPreferences(storage, notify) {
  const state = {
    language: 'auto',
    pinnedProjects: new Set(),
    pinnedTerminals: new Set(),
    pinVersion: crypto.randomUUID()
  }
  let loaded = false
  let queue = Promise.resolve()
  function enqueue(operation) {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  async function restore() {
    if (loaded) return
    const [language, projects, terminals] = await Promise.all(
      Object.values(keys).map((key) => storage.get(key))
    )
    if (storage.keys && [language, projects, terminals].some((item) => item == null)) {
      const inventory = await storage.keys()
      for (const [field, value] of Object.entries({
        language,
        pinnedProjects: projects,
        pinnedTerminals: terminals
      })) {
        if (value == null && (inventory.includes(keys[field]) || state[field]?.size))
          throw new Error('Inconsistent preference storage')
      }
    }
    const pinnedProjects = savedPins(projects)
    const pinnedTerminals = savedPins(terminals)
    Object.assign(state, {
      language: languages.includes(language) ? language : 'auto',
      pinnedProjects,
      pinnedTerminals
    })
    loaded = true
  }
  return {
    read: () =>
      enqueue(async () => {
        try {
          await restore()
          return { ...state }
        } catch {
          return { ...state, preferencesUnavailable: true }
        }
      }),
    change: (input) =>
      enqueue(async () => {
        await restore()
        const { field, key, value } = input ?? {}
        let next
        if (field === 'language' && languages.includes(value)) {
          next = value
        } else if (
          (field === 'pinnedProjects' || field === 'pinnedTerminals') &&
          typeof key === 'string' &&
          key.length
        ) {
          // Re-read this field at the point of mutation. A legacy writer or a
          // transient empty read during startup must not discard unrelated pins.
          const stored = await storage.get(keys[field])
          if (
            stored == null &&
            (state[field].size || (await storage.keys?.())?.includes(keys[field]))
          )
            throw new Error('Inconsistent preference storage')
          const pins = savedPins(stored)
          if (!pins.delete(key)) pins.add(key)
          next = [...pins]
          // Orca measures each JSON value as UTF-8. A removal always stays possible.
          if (pins.has(key) && new TextEncoder().encode(JSON.stringify(next)).length > 256 * 1024)
            return { saved: false, reason: 'pinLimit' }
        } else {
          throw new Error('Invalid view preference')
        }
        // Keep both original storage keys and their existing arrays. Each fits one
        // atomic host write (256 KiB per value), independently of the recorder.
        try {
          await storage.set(keys[field], next)
          const saved = await storage.get(keys[field])
          if (JSON.stringify(saved) !== JSON.stringify(next))
            throw new Error('Preference write was not confirmed')
        } catch (error) {
          loaded = false
          throw error
        }
        if (field === 'language') state.language = next
        else {
          state[field] = new Set(next)
          state.pinVersion = crypto.randomUUID()
        }
        notify()
        return { saved: true }
      })
  }
}
