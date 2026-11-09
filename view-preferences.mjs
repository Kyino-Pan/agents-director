const KEYS = {
  hours: 'view:window-hours',
  compactLanes: 'view:compact-lanes',
  hideShortTasks: 'view:hide-short-tasks'
}
const valid = (key, value) =>
  key === 'hours'
    ? Number.isFinite(value) && value >= 1 / 60 && value <= 168
    : typeof value === 'boolean'

export async function loadViewPreferences(
  storage = window.orca?.storage ?? {
    get: async (key) => JSON.parse(localStorage.getItem(`agent-activity:${key}`)),
    set: async (key, value) => localStorage.setItem(`agent-activity:${key}`, JSON.stringify(value))
  }
) {
  const state = { hours: 24, compactLanes: false, hideShortTasks: true }
  await Promise.all(
    Object.entries(KEYS).map(async ([key, storedKey]) => {
      try {
        const value = await storage.get(storedKey)
        if (valid(key, value)) {
          state[key] = value
        }
      } catch (error) {
        console.warn('Activity view preference could not be restored:', error.message)
      }
    })
  )
  let timer
  let writing = Promise.resolve()
  const pending = new Map()
  const flush = () => {
    clearTimeout(timer)
    const changes = [...pending]
    pending.clear()
    writing = writing.then(async () => {
      for (const [key, value] of changes) {
        try {
          await storage.set(KEYS[key], value)
        } catch (error) {
          console.warn('Activity view preference could not be saved:', error.message)
        }
      }
    })
    return writing
  }
  return Object.assign(state, {
    set(patch, defer = false) {
      for (const [key, value] of Object.entries(patch)) {
        if (Object.hasOwn(KEYS, key) && valid(key, value) && state[key] !== value) {
          state[key] = value
          pending.set(key, value)
        }
      }
      clearTimeout(timer)
      if (defer) {
        timer = setTimeout(flush, 150)
      } else {
        void flush()
      }
    },
    flush
  })
}
