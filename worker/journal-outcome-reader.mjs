import { timestamp } from './activity-store.mjs'

const PAGE_SIZE = 2000
const MAX_ACTIVITY_ITEMS = 5000

function activityRow(item, epoch) {
  const body = item?.body
  if (!body || typeof item.itemId !== 'string' || timestamp(item.observedAt) === null) {
    throw new Error('Invalid journal outcome item')
  }
  const blocks = (body.blocks ?? []).filter(
    (block) =>
      block?.type === 'subagent' || block?.kind === 'subagent' || block?.agents || block?.children
  )
  if (
    !['turn', 'approval', 'question'].includes(body.kind) &&
    !body.turnLifecycle &&
    !blocks.length
  ) {
    return null
  }
  return {
    kind: 'item',
    epoch,
    itemId: item.itemId,
    ts: item.observedAt,
    body: {
      kind: body.kind,
      ...(body.kind === 'turn'
        ? {
            startedAt: body.startedAt,
            requestedAt: body.requestedAt,
            completedAt: body.completedAt,
            state: body.state
          }
        : {}),
      turnLifecycle: body.turnLifecycle,
      resolution: body.resolution,
      blocks
    }
  }
}

function keepItem(items, key, row) {
  if (row) items.set(key, row)
  else items.delete(key)
  if (items.size > MAX_ACTIVITY_ITEMS)
    throw new Error('Journal activity exceeds the 5000-item reader limit')
}

function prefixRow(pending, row) {
  if (row.v > 4) throw new Error('Unsupported journal prefix version')
  if (row.kind === 'lifecycle-batch') {
    for (const mutation of row.mutations) {
      prefixRow(pending, { ...row, ...mutation, ts: mutation.observedAt ?? row.ts })
    }
  } else if (row.kind === 'item') {
    keepItem(pending.items, row.itemId, activityRow({ ...row, observedAt: row.ts }, row.epoch))
  } else if (
    row.kind === 'tombstone' &&
    !['stopEvent', 'queueResume', 'queueReopen', 'queueClear'].some((key) => row[key] !== undefined)
  ) {
    pending.items.delete(row.itemId)
  }
}

export class JournalOutcomeReader {
  sessions = new Map()

  read(db, publish) {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
    )
    if (!tables.has('journal_outcome_epochs')) return { sessions: new Set(), detail: '' }
    const sources = db
      .prepare(`SELECT o.* FROM journal_outcome_epochs o
      JOIN journal_sessions s ON s.session_id = o.session_id AND s.epoch = o.epoch`)
      .all()
    const sessions = new Set(sources.map((source) => source.session_id))
    const warnings = new Set()
    let budget = PAGE_SIZE
    let imported = 0
    for (const source of sources) {
      const {
        session_id: sessionId,
        epoch,
        generation,
        through_seq: through,
        prefix_seq: prefix
      } = source
      try {
        if (![1, 2].includes(source.format))
          throw new Error(`Unsupported journal outcome format ${source.format}`)
        const marker = db
          .prepare(
            'SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?'
          )
          .get(sessionId, epoch, prefix + 1)
        const value = marker && JSON.parse(marker.row_json)
        if (value?.v !== 5 || value.kind !== 'outcomes')
          throw new Error('Missing or unsupported journal outcome marker')
        let state = this.sessions.get(sessionId)
        if (
          !state ||
          state.generation !== generation ||
          state.epoch !== epoch ||
          state.through > through ||
          state.pending?.through > through
        ) {
          state = { generation, epoch, through: -1, items: new Map() }
          this.sessions.set(sessionId, state)
        }
        if (state.through === through && !state.pending) continue
        const pending = (state.pending ??= {
          through,
          prefix: state.through < 0 ? 0 : prefix,
          key: '',
          items: new Map(state.items)
        })
        if (pending.prefix < prefix && budget > 0) {
          const rows = db
            .prepare(`SELECT seq, row_json FROM journal_rows
            WHERE session_id = ? AND epoch = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
            .all(sessionId, epoch, pending.prefix, prefix, budget)
          for (const row of rows) prefixRow(pending, JSON.parse(row.row_json))
          budget -= rows.length
          pending.prefix = rows.at(-1)?.seq ?? prefix
        }
        if (pending.prefix < prefix) continue
        const newest =
          db.prepare(`SELECT entry_key, format, value_json, deleted FROM journal_outcomes
          WHERE generation = ? AND field = 'items' AND entry_key > ? AND seq > ? AND seq <= ?
          ORDER BY entry_key, seq DESC LIMIT 1`)
        while (budget > 0) {
          const row = newest.get(generation, pending.key, state.through, pending.through)
          if (!row) {
            publish(sessionId, pending.items.values())
            state.items = pending.items
            state.through = pending.through
            delete state.pending
            imported++
            break
          }
          if (![1, 2].includes(row.format))
            throw new Error(`Unsupported journal outcome record format ${row.format}`)
          const key = JSON.parse(row.entry_key)
          if (typeof key !== 'string') throw new Error('Invalid journal outcome key')
          const item = JSON.parse(row.value_json)
          if (row.deleted ? item !== null : item?.itemId !== key)
            throw new Error('Mismatched journal outcome item')
          keepItem(pending.items, key, row.deleted ? null : activityRow(item, epoch))
          pending.key = row.entry_key
          budget--
        }
      } catch (error) {
        this.sessions.delete(sessionId)
        warnings.add(error.message)
      }
    }
    for (const sessionId of this.sessions.keys()) {
      if (!sessions.has(sessionId)) this.sessions.delete(sessionId)
    }
    const catchingUp = [...this.sessions.values()].some((state) => state.pending)
    if (catchingUp) warnings.add('Journal outcomes catching up in batches')
    return {
      sessions,
      limited: warnings.size > 0,
      detail: `${imported} outcome sessions updated${warnings.size ? `; ${[...warnings].join('; ')}` : ''}`
    }
  }
}
