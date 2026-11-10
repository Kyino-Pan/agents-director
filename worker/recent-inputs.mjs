import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import { openSourceFile } from './source-files.mjs'
import { timestamp } from './activity-store.mjs'

export const INPUT_LIMIT = 3
export const TEXT_LIMIT = 4000
const READ_BYTES = 32 * 1024 * 1024
const ROW_BYTES = 1024 * 1024
const JOURNAL_ROWS = 2000
const JOURNAL_BYTES = 16 * 1024 * 1024
const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const automated = (value) =>
  value &&
  (value.isMeta === true ||
    value.isSynthetic === true ||
    value.isCompactSummary === true ||
    value.from !== undefined ||
    (value.source?.kind && !['user', 'human'].includes(value.source.kind)) ||
    (value.origin?.kind && !['user', 'human'].includes(value.origin.kind)))

function textParts(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part) =>
        ['text', 'input_text'].includes(part?.type) &&
        typeof part.text === 'string' &&
        !automated(part) &&
        !part.text.trimStart().startsWith('<skill>')
    )
    .map((part) => part.text)
    .join('\n')
}

function input(id, at, text) {
  if (!text.trim()) return null
  return {
    id:
      String(id).length <= 256
        ? String(id)
        : `sha256:${createHash('sha256').update(String(id)).digest('hex')}`,
    at: timestamp(at),
    text: text.slice(0, TEXT_LIMIT),
    truncated: text.length > TEXT_LIMIT
  }
}

function latest(items) {
  return [...items]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.order - a.order)
    .slice(0, INPUT_LIMIT)
    .map(({ order: _order, ...item }) => item)
}

// Keep only the three newest candidates per representation, never an all-session prompt index.
function keep(items, item, order) {
  if (!item) return
  const existing = items.findIndex((entry) => entry.id === item.id)
  if (existing !== -1) items.splice(existing, 1)
  items.push({ ...item, order })
  items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.order - a.order)
  items.splice(INPUT_LIMIT)
}

export async function transcriptInputs(entry, roots) {
  if (!['codex', 'claude'].includes(entry.provider) || extname(entry.path) !== '.jsonl')
    throw new Error('Unsupported transcript')
  const file = await openSourceFile(entry.path, roots)
  try {
    const { size } = await file.stat()
    // Read the header even for a tail: paginated Codex model-only copies must never be user turns.
    const header = Buffer.alloc(Math.min(ROW_BYTES, size))
    const headRead = await file.read(header, 0, header.length, 0)
    const first = parse(header.subarray(0, headRead.bytesRead).toString('utf8').split('\n')[0])
    const nativeId =
      first?.type === 'session_meta' ? first.payload?.id : !first?.type ? first?.id : null
    if (entry.provider === 'codex' && nativeId && nativeId !== entry.providerSessionId)
      throw new Error('Transcript identity mismatch')
    const paginated = first?.payload?.history_mode === 'paginated'
    const start = Math.max(0, size - READ_BYTES + header.length)
    const bytes = Buffer.alloc(size - start)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start)
    let offset = start ? bytes.indexOf(10) + 1 : 0
    let limited = start > 0
    const candidates = { completed: [], event: [], response: [], claude: [] }
    let sawEvent = false
    let sawCompleted = false
    for (let end; (end = bytes.indexOf(10, offset)) !== -1 && end < bytesRead; offset = end + 1) {
      if (end - offset > ROW_BYTES) {
        limited = true
        continue
      }
      const row = parse(bytes.subarray(offset, end).toString('utf8'))
      if (!row) continue
      const p = row.payload
      if (row.type === 'event_msg' && p?.type === 'user_message') sawEvent = true
      if (
        row.type === 'event_msg' &&
        p?.type === 'item_completed' &&
        ['UserMessage', 'user_message'].includes(p.item?.type)
      )
        sawCompleted = true
      if (automated(row) || automated(p)) continue
      const at = row.timestamp ?? row.ts
      const fallback = `line:${start + offset}`
      if (entry.provider === 'claude') {
        if (row.sessionId && row.sessionId !== entry.providerSessionId) continue
        let message = row.message
        if (row.type === 'attachment') {
          const a = row.attachment
          if (
            a?.type !== 'queued_command' ||
            a.commandMode !== 'prompt' ||
            a.humanTurn === false ||
            (a.origin?.kind !== undefined && a.origin.kind !== 'human')
          )
            continue
          message = { role: 'user', content: a.prompt }
        } else if (row.type !== 'user') continue
        if (message?.role !== 'user' || automated(message)) continue
        keep(candidates.claude, input(row.uuid ?? fallback, at, textParts(message.content)), offset)
      } else if (
        row.type === 'event_msg' &&
        p?.type === 'item_completed' &&
        ['UserMessage', 'user_message'].includes(p.item?.type)
      ) {
        sawCompleted = true
        if (!automated(p.item))
          keep(
            candidates.completed,
            input(p.item.id ?? fallback, at, textParts(p.item.content)),
            offset
          )
      } else if (row.type === 'event_msg' && p?.type === 'user_message') {
        sawEvent = true
        keep(
          candidates.event,
          input(p.id ?? fallback, at, typeof p.message === 'string' ? p.message : ''),
          offset
        )
      } else if (
        (row.type === 'response_item' && p?.type === 'message' && p.role === 'user') ||
        (row.type === 'message' && row.role === 'user')
      ) {
        const message = p ?? row
        keep(
          candidates.response,
          input(message.id ?? fallback, at, textParts(message.content)),
          offset
        )
      }
    }
    // These are alternate transcript representations, not independent user turns. Paginated
    // history owns visible items; legacy event messages own prompts over model-context copies.
    if (entry.provider === 'codex' && start > 0 && !paginated && !sawCompleted && !sawEvent)
      throw new Error('Cannot establish visible history from this transcript tail')
    const items =
      entry.provider === 'claude'
        ? candidates.claude
        : paginated || sawCompleted
          ? candidates.completed
          : sawEvent
            ? candidates.event
            : candidates.response
    return { inputs: latest(items), limited }
  } finally {
    await file.close()
  }
}

export function journalInputs(db, sessionId) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name)
  )
  const epoch = db
    .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
    .get(sessionId)?.epoch
  if (!epoch) throw new Error('No saved Chat epoch')
  const outcome = tables.has('journal_outcome_epochs')
    ? db
        .prepare('SELECT * FROM journal_outcome_epochs WHERE session_id = ? AND epoch = ?')
        .get(sessionId, epoch)
    : null
  if (outcome && ![1, 2].includes(outcome.format)) throw new Error('Unsupported journal format')
  const items = new Map()
  const aliases = new Map()
  let rows = 0
  let bytes = 0
  const limited = false
  const decode = (json) => {
    if (
      json === null ||
      ++rows > JOURNAL_ROWS ||
      (bytes += Buffer.byteLength(json)) > JOURNAL_BYTES
    )
      throw new Error('Recent input reader limit reached')
    const value = parse(json)
    if (!value) throw new Error('Invalid journal record')
    return value
  }
  const accept = (row) => {
    if (row.kind === 'lifecycle-batch') {
      for (const mutation of [...row.mutations].reverse())
        accept({ ...row, ...mutation, ts: mutation.observedAt ?? row.ts })
    } else if (typeof row.itemId === 'string' && !items.has(row.itemId)) {
      if (row.kind === 'item') {
        const b = row.body
        const value =
          b?.kind === 'message' && b.role === 'user' && !automated(b) && !automated(row)
            ? input(row.itemId, row.observedAt ?? row.ts, textParts(b.blocks))
            : null
        items.set(row.itemId, value && { ...value, order: row.sequence ?? row.seq ?? 0 })
        if (typeof row.echoOf === 'string' && !aliases.has(row.itemId))
          aliases.set(row.itemId, row.echoOf)
      } else if (
        row.kind === 'tombstone' &&
        !['stopEvent', 'queueResume', 'queueReopen', 'queueClear', 'retireSubmission'].some(
          (key) => row[key] !== undefined
        )
      )
        items.set(row.itemId, null)
    }
    if (items.size + aliases.size > JOURNAL_ROWS)
      throw new Error('Recent input reader limit reached')
  }
  const bounded = (column) =>
    `CASE WHEN length(CAST(${column} AS BLOB)) <= ${ROW_BYTES} THEN ${column} ELSE NULL END`
  if (outcome) {
    const marker = db
      .prepare(
        `SELECT ${bounded('row_json')} AS json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?`
      )
      .get(sessionId, epoch, outcome.prefix_seq + 1)
    const value = marker && decode(marker.json)
    if (value?.v !== 5 || value.kind !== 'outcomes')
      throw new Error('Missing journal outcome marker')
    // Current published values only, including deletions; do not resurrect a deleted inline item.
    const newest =
      db.prepare(`SELECT field, entry_key, format, deleted, ${bounded('value_json')} AS json
      FROM journal_outcomes WHERE generation = ? AND field = ? AND entry_key > ? AND seq <= ?
      ORDER BY entry_key, seq DESC LIMIT 1`)
    for (const field of ['items', 'aliases', 'itemEchoes']) {
      let after = ''
      for (;;) {
        const row = newest.get(outcome.generation, field, after, outcome.through_seq)
        if (!row) break
        after = row.entry_key
        if (![1, 2].includes(row.format)) throw new Error('Unsupported journal item format')
        const key = parse(row.entry_key)
        if (typeof key !== 'string' || key.length > 2048) throw new Error('Invalid journal key')
        const value = decode(row.deleted && row.json === 'null' ? '{}' : row.json)
        if (row.field === 'items') {
          if (row.deleted) items.set(key, null)
          else {
            if (value.itemId !== key) throw new Error('Mismatched journal item')
            accept({ ...value, kind: 'item' })
          }
        } else if (row.deleted) {
          aliases.set(key, null)
        } else if (
          !row.deleted &&
          Array.isArray(value) &&
          value[0] === key &&
          typeof value[1] === 'string'
        )
          aliases.set(key, value[1])
        if (items.size + aliases.size > JOURNAL_ROWS)
          throw new Error('Recent input reader limit reached')
      }
    }
  }
  for (const row of db
    .prepare(`SELECT ${bounded('row_json')} AS json FROM journal_rows
    WHERE session_id = ? AND epoch = ? AND seq <= ? ORDER BY seq DESC LIMIT ?`)
    .iterate(sessionId, epoch, outcome?.prefix_seq ?? Number.MAX_SAFE_INTEGER, JOURNAL_ROWS + 1)) {
    const value = decode(row.json)
    if (value.v > 4 || value.kind === 'outcomes') throw new Error('Unsupported journal history')
    accept(value)
  }
  const turns = new Map()
  for (const [id, value] of items) {
    if (!value) continue
    let canonical = id
    const visited = new Set()
    while (typeof aliases.get(canonical) === 'string' && !visited.has(canonical)) {
      visited.add(canonical)
      canonical = aliases.get(canonical)
    }
    if (items.has(canonical) && !items.get(canonical)) continue
    if (!turns.has(canonical) || id === canonical) turns.set(canonical, value)
  }
  return { inputs: latest(turns.values()), limited }
}

// One in-flight read globally and one short-lived result. Prompt text never enters ActivityStore,
// snapshots or persistent storage, and callers cannot supply paths or mutable pane aliases.
export class RecentInputs {
  constructor(reader) {
    this.reader = reader
  }
  async read(request) {
    const agentId =
      typeof request?.agentId === 'string' && request.agentId.length <= 2048
        ? request.agentId
        : null
    const agent = typeof agentId === 'string' && this.reader.store.agents.get(agentId)
    if (!agent || Object.keys(request).some((key) => key !== 'agentId'))
      return { agentId, inputs: [], unavailable: true }
    const identity = JSON.stringify([
      agentId,
      agent.sessionId,
      agent.provider,
      agent.providerSessionId
    ])
    if (this.busy) return { agentId, inputs: [], unavailable: true }
    if (this.cached?.identity === identity && Date.now() - this.cached.at < 4000)
      return this.cached.result
    this.busy = true
    let result
    try {
      if (agent.sessionId) {
        const matches = this.reader.directories
          .map((directory) => join(directory, 'agent-session-journal.db'))
          .filter((path) => {
            try {
              return this.reader
                .database(path)
                .prepare('SELECT 1 FROM agent_session_records WHERE session_id = ?')
                .get(agent.sessionId)
            } catch {
              return false
            }
          })
        if (matches.length !== 1) throw new Error('Ambiguous or unavailable Chat source')
        const db = this.reader.database(matches[0])
        db.exec('BEGIN')
        try {
          result = journalInputs(db, agent.sessionId)
        } finally {
          db.exec('ROLLBACK')
        }
      } else {
        const matches = [...this.reader.transcripts.values()].filter(
          (entry) =>
            entry.providerSessionId &&
            entry.providerSessionId === agent.providerSessionId &&
            entry.provider === agent.provider &&
            (this.reader.store.aliases.get(entry.id) ?? entry.id) === agentId
        )
        if (matches.length !== 1) throw new Error('No unique directly recorded transcript')
        result = await transcriptInputs(matches[0], this.reader.transcriptRoots(matches[0]))
      }
      result = { agentId, ...result }
    } catch {
      result = { agentId, inputs: [], unavailable: true }
    } finally {
      this.busy = false
    }
    this.cached = { identity, at: Date.now(), result }
    clearTimeout(this.cacheTimer)
    this.cacheTimer = setTimeout(() => {
      this.cached = null
    }, 4000)
    this.cacheTimer.unref()
    return result
  }
}
