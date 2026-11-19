import { ActivityStore } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'
import { createPublicNavigator } from './public-navigation.mjs'
import { encodeRecorderCache, decodeRecorderCache } from './recorder-cache.mjs'

// Separate public observations from the old private-file collector's identities and routes.
export const STORAGE_PREFIX = 'activity-public-v1'
let stop

export default async function activate(orca) {
  const store = new ActivityStore()
  const collector = new PublicCollector(store, orca.host)
  const navigate = createPublicNavigator(store, orca.host)
  let closing = false
  let timer
  let saving = Promise.resolve()
  let scanning = Promise.resolve()
  let generation = null
  let oldChunks = 0
  let lastSave = 0
  const pendingEvents = []
  let initialized = false
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

  const persist = () => {
    saving = saving
      .catch(() => {})
      .then(async () => {
        let chunks
        try {
          chunks = encodeRecorderCache(store.serialize())
        } catch (error) {
          store.limited = true
          store.source('Recorder cache', 'limited', error.message)
          return
        }
        const next = generation === 'a' ? 'b' : 'a'
        for (let index = 0; index < chunks.length; index++) {
          await orca.storage.set(`${STORAGE_PREFIX}:${next}:${index}`, chunks[index])
        }
        await orca.storage.set(`${STORAGE_PREFIX}:head`, {
          version: 2,
          generation: next,
          chunks: chunks.length
        })
        const previous = generation
        generation = next
        for (let index = 0; previous && index < oldChunks; index++) {
          await orca.storage.delete(`${STORAGE_PREFIX}:${previous}:${index}`)
        }
        oldChunks = chunks.length
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
  const refresh = () => {
    scanning = scanning
      .catch(() => {})
      .then(async () => {
        if (closing) return
        await collector.scan()
        if (Date.now() - lastSave >= 15000) await persist()
        orca.panels.post('activity.changed', { at: Date.now() })
      })
      .catch((error) => store.source('Collector', 'error', error.message))
    return scanning
  }
  let ready
  orca.panels.handle('activity.snapshot', async (input) => {
    await ready
    return store.snapshot(Date.now(), { hideShortTasks: input?.hideShortTasks !== false })
  })
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
  ready = (async () => {
    try {
      const head = await orca.storage.get(`${STORAGE_PREFIX}:head`)
      if (
        head?.version === 2 &&
        ['a', 'b'].includes(head.generation) &&
        Number.isInteger(head.chunks) &&
        head.chunks > 0 &&
        head.chunks <= 100
      ) {
        const chunks = []
        for (let index = 0; index < head.chunks; index++) {
          const chunk = await orca.storage.get(`${STORAGE_PREFIX}:${head.generation}:${index}`)
          if (typeof chunk !== 'string') throw new Error('Public recorder cache is incomplete.')
          chunks.push(chunk)
        }
        store.restore(decodeRecorderCache(head, chunks))
        generation = head.generation
        oldChunks = head.chunks
      }
    } catch (error) {
      store.source('Recorder cache', 'error', error.message)
    }
    await refresh()
    initialized = true
    for (const event of pendingEvents.splice(0)) collector.receive(event)
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
    await ready
    clearTimeout(timer)
    await scanning
    await persist()
  }
  await ready
}

export async function deactivate() {
  await stop?.()
  stop = undefined
}
