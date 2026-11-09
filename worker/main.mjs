import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader, defaultDataDirectory } from './orca-log-reader.mjs'
import { createTerminalNavigator } from './terminal-navigation.mjs'
import { bindStructuredPane } from './session-routing.mjs'
import { TerminalMemory } from './terminal-memory.mjs'

const STORAGE_PREFIX = 'activity-v1'
let stop

function storageChunks(value) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > 1800 * 1024) {
    throw new Error('Recorder cache exceeds 1.8 MiB; reduce source volume')
  }
  const chunks = []
  for (let index = 0; index < text.length; index += 24000) {
    chunks.push(text.slice(index, index + 24000))
  }
  return chunks
}

export default async function activate(orca) {
  const store = new ActivityStore()
  const live = new Map()
  let closing = false
  let timer
  let saving = Promise.resolve()
  let scanning = Promise.resolve()
  let generation = null
  let oldChunks = 0
  let lastSave = 0
  let reader
  let memory
  let initialized = false
  const pendingEvents = []
  const extendLive = (now) => {
    for (const [pane, current] of live) {
      const point = store.points.get(current.key)
      if (
        point &&
        point.agentId === store.aliases.get(`pane:${pane}`) &&
        !(point.ownershipUntil <= now)
      ) {
        point.until = now
        current.agentId = point.agentId
      } else {
        live.delete(pane)
      }
    }
  }

  const receive = (event) => {
    if (!initialized) {
      pendingEvents.push(event)
      return
    }
    const at = Number.isFinite(event.receivedAt) ? event.receivedAt : Date.now()
    const id = store.agent(
      bindStructuredPane(store, event.paneKey) ?? `pane:${event.paneKey}`,
      {
        ...(event.title ? { label: event.title, labelSource: 'terminal' } : {}),
        paneKey: event.paneKey,
        terminalHandle: event.terminalId,
        workspace: event.workspaceId ?? event.worktreeId
      },
      event.terminalId ? [event.terminalId] : []
    )
    const state = event.mainAgent?.state ?? event.state
    const previous = live.get(event.paneKey)
    if (previous?.state === state && previous.agentId === id) {
      return
    }
    if (previous) {
      const point = store.points.get(previous.key)
      if (point) {
        point.until = at
      }
    }
    const key = `live:${event.paneKey}:${at}`
    store.point(key, id, at, state, 'live', at)
    const point = store.points.get(key)
    if (point) {
      point.paneKey = event.paneKey
    }
    live.set(event.paneKey, { key, state, agentId: id })
    orca.panels.post('activity.changed', { at })
  }
  const subscription = orca.events.on('agent.status.changed', receive)

  const persist = () => {
    saving = saving
      .catch(() => {})
      .then(async () => {
        const data = store.serialize()
        let chunks
        try {
          chunks = storageChunks(data)
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
          version: 1,
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
          'Rolling 7-day cache saved; offline gaps remain unknown'
        )
      })
      .catch((error) => {
        store.source('Recorder cache', 'error', error.message)
      })
    return saving
  }

  const refresh = () => {
    scanning = scanning
      .catch(() => {})
      .then(async () => {
        if (closing) {
          return
        }
        const now = Date.now()
        await reader.scan(now)
        extendLive(Date.now())
        store.collectedUntil = now
        store.prune(now)
        if (now - lastSave >= 15000) {
          await persist()
        }
        orca.panels.post('activity.changed', { at: now })
      })
      .catch((error) => {
        store.source('Collector', 'error', String(error.message))
      })
    return scanning
  }

  let ready
  orca.panels.handle('activity.snapshot', async (input) => {
    await ready
    extendLive(Date.now())
    return memory.snapshot(
      store.snapshot(Date.now(), { hideShortTasks: input?.hideShortTasks !== false })
    )
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
        head?.version === 1 &&
        ['a', 'b'].includes(head.generation) &&
        Number.isInteger(head.chunks) &&
        head.chunks <= 100
      ) {
        const chunks = []
        for (let index = 0; index < head.chunks; index++) {
          const chunk = await orca.storage.get(`${STORAGE_PREFIX}:${head.generation}:${index}`)
          if (typeof chunk !== 'string') {
            throw new Error('Recorder cache is incomplete; rebuilding from source logs')
          }
          chunks.push(chunk)
        }
        store.restore(JSON.parse(chunks.join('')))
        generation = head.generation
        oldChunks = head.chunks
      }
    } catch (error) {
      store.source('Recorder cache', 'error', String(error.message))
    }
    const configured = await orca.settings.get('dataDirectories')
    const directories =
      typeof configured === 'string' && configured.trim()
        ? configured
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean)
        : [defaultDataDirectory()]
    reader = new OrcaLogReader(store, [...new Set(directories)])
    memory = new TerminalMemory(store, directories, () =>
      orca.panels.post('activity.changed', { at: Date.now() })
    )
    const navigate = createTerminalNavigator(store, directories)
    orca.panels.handle('activity.navigate', async (input) => {
      await ready
      return navigate(input)
    })
    initialized = true
    for (const event of pendingEvents.splice(0)) {
      receive(event)
    }
    await refresh()
    const tick = async () => {
      await refresh()
      if (!closing) {
        timer = setTimeout(tick, 5000)
      }
    }
    timer = setTimeout(tick, 5000)
  })()

  stop = async () => {
    closing = true
    memory?.close()
    clearTimeout(timer)
    subscription.dispose()
    await ready
    await scanning
    store.collectedUntil = Date.now()
    await persist()
    reader?.close()
  }
  await ready
}

export async function deactivate() {
  await stop?.()
  stop = undefined
}
