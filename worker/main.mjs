import { createOmissionReplies } from './snapshot-omissions.mjs'
import { createHeadingPages } from './project-headings.mjs'
import { createSharedPreferences } from '../shared-preferences.mjs'
import { ActivityStore } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'
import { createPublicNavigator } from './public-navigation.mjs'
import {
  STORAGE_PREFIX,
  encodeRecorderCache,
  decodeRecorderCache,
  readRecorderInventory,
  reclaimUnusedChunks,
  commitRecorderChunks
} from './recorder-cache.mjs'

export { STORAGE_PREFIX }
let stop

export default function activate(orca) {
  const store = new ActivityStore()
  const omissions = createOmissionReplies()
  const headings = createHeadingPages()
  const shared = createSharedPreferences(orca.storage, () =>
    orca.panels.post('activity.changed', { preferences: true })
  )
  const collector = new PublicCollector(store, orca.host)
  const navigate = createPublicNavigator(store, orca.host)
  let closing = false
  let timer
  let saving = Promise.resolve()
  let scanning = Promise.resolve()
  let lastSave = 0
  const pendingEvents = []
  let initialized = false
  let cacheLoaded = false
  let loadedHead = false
  let sawEmptyStore = false
  const knownKeys = new Set()
  const receive = (event) => {
    if (closing) return
    if (!initialized) {
      if (pendingEvents.length < 1000) pendingEvents.push(event)
      return
    }
    collector.receive(event)
    orca.panels.post('activity.changed', { at: Date.now() })
  }
  const subscription = orca.events.on('agent.status.changed', receive)

  const hooks = ['before', 'after'].map((phase) =>
    orca.hooks.on('agent.tool.' + phase, (event) => {
      if (initialized && !closing) collector.relations.observe(phase, event)
    })
  )

  const persist = () => {
    saving = saving
      .catch(() => {})
      .then(async () => {
        const inventory = await readRecorderInventory(orca.storage, knownKeys)
        if (inventory.head && !loadedHead) {
          cacheLoaded = false
          throw new Error('Public recorder history became available. Retrying restore.')
        }
        await reclaimUnusedChunks(orca.storage, inventory, knownKeys)
        let chunks
        try {
          chunks = encodeRecorderCache(store.serialize())
        } catch (error) {
          store.limited = true
          store.source('Recorder cache', 'limited', error.message)
          return
        }
        await commitRecorderChunks(orca.storage, inventory.head, chunks, knownKeys)
        loadedHead = true
        lastSave = Date.now()
        store.source(
          'Recorder cache',
          'ok',
          'Public observations saved for seven days; offline gaps remain unknown.'
        )
      })
      .catch((error) => store.source('Recorder cache', 'error', error.message))
    return saving
  }
  const restore = async () => {
    const { head, keys } = await readRecorderInventory(orca.storage, knownKeys)
    if (!keys.length && !sawEmptyStore) {
      sawEmptyStore = true
      store.source('Recorder cache', 'limited', 'Checking empty storage again on the next refresh.')
      return false
    }
    if (!head) return true
    const chunks = []
    for (let index = 0; index < head.chunks; index++) {
      const chunk = await orca.storage.get(`${STORAGE_PREFIX}:${head.generation}:${index}`)
      if (typeof chunk !== 'string') {
        throw new Error('Could not read a committed public recorder chunk.')
      }
      chunks.push(chunk)
    }
    const saved = decodeRecorderCache(head, chunks)
    loadedHead = true
    if (!initialized) {
      store.restore(saved)
      return true
    }
    // A previous host read failed. Keep observations collected while storage was offline.
    const history = new ActivityStore()
    history.restore(saved)
    store.recover(history)
    collector.relations.reconcileRestoredSenders()
    return true
  }
  const refresh = () => {
    scanning = scanning
      .catch(() => {})
      .then(async () => {
        if (closing) return
        if (!cacheLoaded) {
          try {
            cacheLoaded = await restore()
          } catch (error) {
            store.source('Recorder cache', 'error', error.message)
          }
        }
        await collector.scan()
        if (!initialized) {
          initialized = true
          for (const event of pendingEvents.splice(0)) collector.receive(event)
        }
        if (cacheLoaded && Date.now() - lastSave >= 15000) await persist()
        orca.panels.post('activity.changed', { at: Date.now() })
      })
      .catch((error) => store.source('Collector', 'error', error.message))
    return scanning
  }
  let ready
  orca.panels.handle('activity.snapshot', async (input, context) => {
    await ready
    const prefs = await shared.read()
    const { pinnedProjects, ...snapshot } = store.snapshot(Date.now(), {
      hideShortTasks: input?.hideShortTasks !== false,
      pinnedTerminals: prefs.pinnedTerminals,
      pinnedProjects: prefs.pinnedProjects,
      attempts: collector.relations.attempts()
    })
    return {
      ...omissions.prepare(snapshot, input?.withOmittedActivity && context?.panel.id),
      headingVersion: headings.update(pinnedProjects),
      language: prefs.language,
      pinVersion: prefs.pinVersion,
      preferencesUnavailable: prefs.preferencesUnavailable ?? false
    }
  })
  orca.panels.handle('activity.omittedActivity', (input, context) =>
    omissions.take(context.panel.id, input?.token)
  )
  orca.panels.handle('activity.projectHeadings', (input) => headings.get(input))
  orca.panels.handle('activity.changePreference', (input) => shared.change(input))
  orca.panels.handle('activity.inputs', async (input) => ({
    agentId: input?.agentId,
    inputs: [],
    unavailable: true,
    reason: 'Conversation text is not available through Orca’s public plugin API.'
  }))
  orca.panels.handle('activity.navigate', async (input) => {
    await ready
    return navigate(input)
  })
  orca.commands.register('refresh', async () => {
    await ready
    await refresh()
    return { refreshed: true }
  })
  // Handlers await initialization without charging a large upgrade sweep to host activation.
  ready = (async () => {
    await refresh()
    const tick = async () => {
      await refresh()
      if (!closing) timer = setTimeout(tick, 5000)
    }
    timer = setTimeout(tick, 5000)
  })()
  stop = async () => {
    closing = true
    clearTimeout(timer)
    subscription.dispose()
    for (const hook of hooks) hook.dispose()
    await ready
    clearTimeout(timer)
    await scanning
    if (cacheLoaded) await persist()
  }
}

export async function deactivate() {
  await stop?.()
  stop = undefined
}
