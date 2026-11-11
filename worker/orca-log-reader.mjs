import { DatabaseSync } from 'node:sqlite'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve, extname } from 'node:path'
import { sourceFilePath, openSourceFile, readSourceText } from './source-files.mjs'
import { WINDOW_MS, timestamp } from './activity-store.mjs'
import { readProjectCatalog } from './project-catalog-reader.mjs'
import { readOrchestration } from './orchestration-reader.mjs'
import { bindStructuredPane, SessionRouting } from './session-routing.mjs'
import { JournalOutcomeReader } from './journal-outcome-reader.mjs'

const PAGE_SIZE = 2000
const MAX_LOG_BYTES = 32 * 1024 * 1024

export function defaultDataDirectory(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'orca')
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'orca')
}

const clean = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 2048) || undefined : undefined
const parsed = (value) => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function providerHandle(handle) {
  const provider = clean(handle?.agent ?? handle?.provider)
  const id = clean(
    handle?.nativeId ??
      (provider === 'codex' ? handle?.threadId : provider === 'claude' ? handle?.sessionId : null)
  )
  return { provider, id }
}

export function importJournalRow(store, sessionId, row, now) {
  if (!row || row.kind !== 'item' || !row.body) {
    return
  }
  const id = store.agent(`session:${sessionId}`, { sessionId }, [`orca_session_id:${sessionId}`])
  const body = row.body
  const at = timestamp(row.ts)
  if (at === null) {
    return
  }
  const key = `journal:${sessionId}:${row.epoch}:${row.itemId}`
  const turn = body.kind === 'turn' ? body : body.turnLifecycle
  if (turn) {
    const start = timestamp(turn.startedAt ?? turn.requestedAt)
    const end = timestamp(turn.completedAt)
    if (start !== null) {
      store.point(`${key}:start`, id, start, 'working', 'journal', end ?? at)
      store.points.get(`${key}:start`).unsettled = end === null
    }
    if (end !== null) {
      store.point(
        `${key}:end`,
        id,
        end,
        turn.state === 'unverifiable' ? 'unknown' : 'done',
        'journal'
      )
    }
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    const state = body.resolution?.state
    const resolvedAt = timestamp(body.resolution?.resolvedAt)
    const pointId = `${key}:prompt`
    if (!store.points.has(pointId)) {
      store.point(pointId, id, at, 'waiting', 'journal', resolvedAt ?? at)
    } else {
      store.points.get(pointId).until = resolvedAt ?? at
    }
    store.points.get(pointId).unsettled = !state || state === 'pending'
    if (state && state !== 'pending') {
      store.point(
        `${key}:resolved`,
        id,
        resolvedAt ?? at,
        state === 'resolved' ? 'working' : 'unknown',
        'journal',
        at
      )
    }
  }
  for (const block of body.blocks ?? []) {
    if (block?.type === 'subagent' || block?.kind === 'subagent') {
      importJournalChild(store, id, block, at, now, key)
    }
    for (const child of block?.agents ?? block?.children ?? []) {
      importJournalChild(store, id, child, at, now, key)
    }
  }
}

function importJournalChild(store, parentId, child, at, now, journalKey) {
  const nativeId = clean(child.id ?? child.agentId)
  if (!nativeId) {
    return
  }
  const parent = store.agents.get(parentId)
  const root = parentId
  if (child.parentId) {
    parentId = store.agent(`child:${root}:${child.parentId}`)
  }
  const name = clean(child.label) ?? clean(child.name)
  const description = clean(child.description)
  const id = store.agent(
    `child:${root}:${nativeId}`,
    {
      label: name ?? description ?? clean(child.agentType) ?? nativeId,
      labelSource: name ? 'name' : description ? 'task' : 'fallback',
      providerSessionId: parent?.provider === 'codex' ? nativeId : undefined,
      parentId,
      provider: parent?.provider,
      workspace: parent?.workspace,
      spawnedAt: timestamp(child.startedAt) ?? at
    },
    parent?.provider === 'codex' ? [`native:codex:${nativeId}`] : []
  )
  const start = timestamp(child.startedAt) ?? at
  const end = timestamp(child.settledAt ?? child.completedAt)
  const state = ['working', 'blocked', 'waiting'].includes(child.state)
    ? child.state
    : child.state === 'running'
      ? 'working'
      : 'unknown'
  const run = child.run ?? start
  const key = `${journalKey ? `${journalKey}:` : ''}child:${id}:${run}`
  store.point(
    `${key}:start`,
    id,
    start,
    timestamp(child.startedAt) !== null ? 'working' : state,
    'journal',
    end ?? Math.min(at, now)
  )
  store.points.get(`${key}:start`).unsettled = end === null
  if (state !== 'working' && end === null && at > start) {
    store.point(`${key}:state:${at}`, id, at, state, 'journal', at)
  }
  if (end !== null) {
    store.point(`${key}:end`, id, end, 'done', 'journal')
  }
}

export function importStatusRow(store, paneKey, row, now) {
  const payload = row.payload ?? {}
  const session = payload.providerSession ?? row.providerSession
  const provider =
    clean(session?.agent ?? row.agent ?? row.agentType ?? payload.agentType) ?? 'agent'
  const native = clean(session?.id)
  const task = payload.orchestration ?? row.orchestration
  const taskName = clean(task?.displayName) ?? clean(task?.taskTitle)
  const title = clean(payload.terminalTitle ?? row.terminalTitle)
  const identity = native ? `native:${provider}:${native}` : `pane:${paneKey}`
  const previousPane = store.agents.get(store.aliases.get(identity) ?? identity)?.paneKey
  const id = store.agent(
    identity,
    {
      label: taskName ?? title ?? `${provider} · ${native?.slice(0, 8) ?? paneKey.slice(-8)}`,
      labelSource: taskName ? 'task' : title ? 'terminal' : 'fallback',
      provider,
      providerSessionId: native,
      resumeTarget:
        native && !paneKey.startsWith('structured-agent-session-')
          ? {
              kind: 'terminal',
              provider,
              providerSessionId: native,
              providerSessionKey: clean(session?.key),
              workspace: clean(row.worktreeId)?.replace(/^worktree:/, ''),
              executionHostId:
                row.connectionId === null
                  ? 'local'
                  : clean(row.connectionId)
                    ? `ssh:${clean(row.connectionId)}`
                    : undefined,
              wslDistro: null
            }
          : undefined,
      paneKey,
      terminalHandle: clean(row.terminalHandle),
      workspace: clean(row.worktreeId),
      taskId: clean(task?.taskId),
      dispatchId: clean(task?.dispatchId),
      runId: clean(task?.orchestrationRunId)
    },
    task?.dispatchId ? [`dispatch:${task.dispatchId}`] : []
  )
  // A terminal may resume a different conversation; only provider/session ids are durable identity.
  const prior = store.aliases.get(`pane:${paneKey}`)
  if (native && prior === `pane:${paneKey}` && prior !== id) {
    store.merge(prior, id)
  }
  store.aliases.set(`pane:${paneKey}`, id)
  if (row.terminalHandle) {
    store.aliases.set(row.terminalHandle, id)
  }
  const main = payload.mainAgent
  const at = timestamp(main?.stateStartedAt ?? row.stateStartedAt ?? row.receivedAt)
  const observed = timestamp(row.evidenceObservedAt ?? row.receivedAt) ?? at
  const point = (start, state, until) => {
    if (start === null) return
    const key = `status:${paneKey}:${id}:${start}`
    const legacy = store.points.get(`status:${id}:${start}`)
    if (legacy && !legacy.paneKey) {
      const panes = new Set(
        [
          previousPane,
          ...[...store.points.values()].filter((p) => p.agentId === id).map((p) => p.paneKey)
        ].filter(Boolean)
      )
      if (panes.size === 1) legacy.paneKey = [...panes][0]
    }
    const migrate = legacy?.paneKey === paneKey
    const ownershipUntil = Math.min(
      store.points.get(key)?.ownershipUntil ?? Infinity,
      migrate ? (legacy.ownershipUntil ?? Infinity) : Infinity
    )
    if (migrate) store.points.delete(legacy.id)
    store.point(key, id, start, state, 'status-cache', until)
    const saved = store.points.get(key)
    if (saved) {
      Object.assign(saved, {
        paneKey,
        terminalHandle: clean(row.terminalHandle),
        workspace: clean(row.worktreeId)
      })
      // Re-reading a stale cache cannot revoke an already established boundary.
      if (Number.isFinite(ownershipUntil)) {
        saved.ownershipUntil = ownershipUntil
        saved.until = Math.min(saved.until ?? Infinity, ownershipUntil)
      }
    }
  }
  point(at, main?.state ?? payload.state, observed)
  for (const entry of row.stateHistory ?? payload.stateHistory ?? []) {
    const start = timestamp(entry.mainAgent?.stateStartedAt ?? entry.startedAt)
    point(start, entry.mainAgent?.state ?? entry.state, timestamp(entry.observedAt) ?? observed)
  }
  for (const child of payload.subagents ?? []) {
    importJournalChild(store, id, child, observed ?? now, now)
  }
  const path = session?.transcriptPath
  return !row.connectionId && typeof path === 'string' && isAbsolute(path)
    ? { path, id, provider, providerSessionId: native }
    : null
}

export function importTranscriptRow(store, agentId, provider, row, fileKey) {
  const at = timestamp(row?.timestamp ?? row?.ts)
  const payload = row?.payload
  if (at === null) {
    return
  }
  if (provider === 'codex' && row.type === 'event_msg') {
    const states = { task_started: 'working', task_complete: 'done', turn_aborted: 'done' }
    if (states[payload?.type]) {
      if (states[payload.type] === 'done') {
        settleTranscriptWork(store, agentId, at)
      }
      store.point(
        `${fileKey}:${at}:${payload.type}`,
        agentId,
        at,
        states[payload.type],
        'transcript',
        states[payload.type] === 'working' ? at : undefined
      )
      if (states[payload.type] === 'working') {
        store.points.get(`${fileKey}:${at}:${payload.type}`).unsettled = true
      }
    }
    if (payload?.type === 'sub_agent_activity' && payload.agent_thread_id) {
      const childAt = timestamp(payload.occurred_at_ms) ?? at
      const id = store.agent(`native:codex:${payload.agent_thread_id}`, {
        label: clean(payload.agent_path),
        labelSource: 'path',
        provider: 'codex',
        providerSessionId: clean(payload.agent_thread_id),
        parentId: agentId,
        spawnedAt: childAt
      })
      if (payload.kind === 'completed') {
        settleTranscriptWork(store, id, childAt)
      }
      store.point(
        `${fileKey}:${id}:${childAt}`,
        id,
        childAt,
        payload.kind === 'started' ? 'working' : payload.kind === 'completed' ? 'done' : 'unknown',
        'transcript',
        payload.kind === 'started' ? childAt : undefined
      )
      if (payload.kind === 'started') {
        store.points.get(`${fileKey}:${id}:${childAt}`).unsettled = true
      }
    }
  }
  if (provider === 'claude') {
    const state =
      row.type === 'user' && !row.isMeta && typeof row.message?.content === 'string'
        ? 'working'
        : row.type === 'assistant' && row.message?.stop_reason === 'end_turn'
          ? 'done'
          : null
    if (state) {
      if (state === 'done') {
        settleTranscriptWork(store, agentId, at)
      }
      store.point(
        `${fileKey}:${row.uuid ?? at}`,
        agentId,
        at,
        state,
        'transcript',
        state === 'working' ? at : undefined
      )
      if (state === 'working') {
        store.points.get(`${fileKey}:${row.uuid ?? at}`).unsettled = true
      }
    }
  }
}

function settleTranscriptWork(store, agentId, at) {
  let previous
  const canonical = store.aliases.get(agentId) ?? agentId
  for (const point of store.points.values()) {
    if (
      point.agentId === canonical &&
      point.source === 'transcript' &&
      point.at < at &&
      (!previous || point.at > previous.at)
    ) {
      previous = point
    }
  }
  if (previous?.state === 'working') {
    previous.until = at
    previous.unsettled = false
  }
}

export class OrcaLogReader {
  databases = new Map()
  databaseFiles = new Map()
  journalCursors = new Map()
  journalOutcomes = new Map()
  journalWarnings = new Map()
  transcripts = new Map()
  warned = new Set()

  constructor(store, directories) {
    this.store = store
    this.directories = directories
  }

  database(path) {
    const canonical = sourceFilePath(path, this.directories)
    let db = this.databases.get(path)
    if (!db) {
      db = new DatabaseSync(canonical, { readOnly: true, timeout: 250, allowExtension: false })
      db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF')
      this.databases.set(path, db)
    }
    return db
  }

  async scan(now = Date.now()) {
    this.store.projectCatalog.clear()
    this.store.terminalClosures.clear()
    const catalogs = new Map()
    for (const directory of this.directories) {
      const tabWorkspaces = await readProjectCatalog(this, directory)
      await this.scanSource(join(directory, 'agent-session-journal.db'), () =>
        this.journal(directory, now)
      )
      catalogs.set(directory, tabWorkspaces)
      const statusPath = join(directory, 'agent-hooks', 'last-status.json')
      await this.scanSource(statusPath, async () => {
        const contents = await readSourceText(statusPath, [directory], MAX_LOG_BYTES)
        const status = JSON.parse(contents)
        for (const [pane, row] of Object.entries(status.entries ?? {})) {
          const transcript = importStatusRow(this.store, pane, row, now)
          if (transcript) {
            this.transcripts.set(transcript.path, {
              ...this.transcripts.get(transcript.path),
              ...transcript,
              directory
            })
          }
        }
        return `${Object.keys(status.entries ?? {}).length} cached panes; cache alone does not prove live activity`
      })
    }
    for (const transcript of this.transcripts.values()) {
      await this.scanSource(transcript.path, () => this.transcript(transcript, now))
    }
    for (const agent of this.store.agents.values()) {
      bindStructuredPane(this.store, agent.paneKey)
    }
    new SessionRouting(this.store).repairLivePoints()
    for (const [directory, catalog] of catalogs) {
      await this.scanSource(join(directory, 'orchestration.db'), () =>
        readOrchestration(this, directory, now, catalog)
      )
    }
  }

  async scanSource(path, scan) {
    try {
      if (path.endsWith('.db')) sourceFilePath(path, this.directories)
      const info = await stat(path)
      if (path.endsWith('.db')) {
        const fingerprint = `${info.dev}:${info.ino}`
        const previous = this.databaseFiles.get(path)
        if (previous && previous !== fingerprint) {
          this.databases.get(path)?.close()
          this.databases.delete(path)
          this.journalCursors.delete(path)
          this.journalOutcomes.delete(path)
          this.journalWarnings.delete(path)
        }
        this.databaseFiles.set(path, fingerprint)
      }
      const detail = await scan()
      this.store.source(path, detail?.limited ? 'limited' : 'ok', detail?.detail ?? detail)
    } catch (error) {
      this.store.source(
        path,
        error.code === 'ENOENT' ? 'missing' : 'error',
        error.code === 'ENOENT'
          ? 'Not present on this collector host'
          : String(error.message).slice(0, 300)
      )
      const db = this.databases.get(path)
      if (db) {
        db.close()
        this.databases.delete(path)
        this.journalCursors.delete(path)
        this.journalOutcomes.delete(path)
      }
    }
  }

  journal(directory, now) {
    const path = join(directory, 'agent-session-journal.db')
    const db = this.database(path)
    db.exec('BEGIN')
    try {
      return this.journalSnapshot(db, path, now)
    } finally {
      db.exec('ROLLBACK')
    }
  }

  journalSnapshot(db, path, now) {
    const records = db.prepare('SELECT session_id, record_json FROM agent_session_records').all()
    for (const record of records) {
      const value = parsed(record.record_json)
      if (!value) {
        continue
      }
      const aliases = [`orca_session_id:${record.session_id}`]
      for (const link of value.providerHandleChain ?? []) {
        const handle = providerHandle(link.handle)
        if (handle.id) {
          aliases.push(`native:${handle.provider ?? value.provider}:${handle.id}`)
        }
      }
      this.store.agent(
        `session:${record.session_id}`,
        {
          label:
            clean(value.conversationName) ??
            `${value.provider ?? 'agent'} · ${record.session_id.slice(0, 8)}`,
          labelSource: clean(value.conversationName)
            ? value.conversationNameSource === 'user'
              ? 'user'
              : 'conversation'
            : 'fallback',
          sessionId: record.session_id,
          providerSessionId: providerHandle(value.providerHandleChain?.at(-1)?.handle).id,
          provider: clean(value.provider),
          workspace: clean(value.location?.workspaceId),
          resumeTarget: {
            kind: 'chat',
            sessionId: record.session_id,
            provider: clean(value.provider),
            workspace: clean(value.location?.workspaceId)?.replace(/^worktree:/, ''),
            executionHostId: clean(value.location?.executionHostId),
            wslDistro: value.location?.wslDistro
          }
        },
        aliases
      )
    }
    let outcomes = this.journalOutcomes.get(path)
    if (!outcomes) {
      outcomes = new JournalOutcomeReader()
      this.journalOutcomes.set(path, outcomes)
    }
    const coverage = outcomes.read(db, (sessionId, items) => {
      const prefix = `journal:${sessionId}:`
      for (const [id] of this.store.points) {
        if (id.startsWith(prefix)) this.store.points.delete(id)
      }
      for (const item of items) importJournalRow(this.store, sessionId, item, now)
    })
    const warnings = this.journalWarnings.get(path) ?? new Set()
    this.journalWarnings.set(path, warnings)
    for (const sessionId of coverage.sessions) warnings.delete(sessionId)
    const tip = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM journal_rows').get().last
    let before = this.journalCursors.get(path) ?? 0
    if (before > tip) {
      before = 0
    }
    const rows = db
      .prepare(`SELECT rowid, session_id, row_json FROM journal_rows
      WHERE rowid > ? AND (ts >= ? OR row_json LIKE '%"running"%') ORDER BY rowid LIMIT ?`)
      .all(before, now - WINDOW_MS, PAGE_SIZE)
    for (const row of rows) {
      if (coverage.sessions.has(row.session_id)) continue
      const value = parsed(row.row_json)
      if (value?.kind === 'outcomes' || value?.v > 4) {
        warnings.add(row.session_id)
      } else {
        importJournalRow(this.store, row.session_id, value, now)
      }
    }
    const last = rows.at(-1)?.rowid ?? before
    this.journalCursors.set(path, rows.length === PAGE_SIZE ? last : tip)
    if (rows.length === PAGE_SIZE) {
      this.store.limited = true
    }
    return {
      limited: coverage.limited || warnings.size > 0 || rows.length === PAGE_SIZE,
      detail: `${rows.length} journal rows read this pass; ${coverage.detail}${warnings.size ? '; Unsupported journal history or missing outcome source' : ''}${rows.length === PAGE_SIZE ? '; catching up in batches' : ''}`
    }
  }

  transcriptRoots(entry) {
    const roots = [entry.directory]
    if (resolve(entry.directory) === resolve(defaultDataDirectory())) {
      const home =
        entry.provider === 'codex'
          ? process.env.CODEX_HOME || join(homedir(), '.codex')
          : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
      roots.push(
        ...(entry.provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']).map(
          (part) => join(home, part)
        )
      )
    }
    return roots
  }

  async transcript(entry, now) {
    if (!['codex', 'claude'].includes(entry.provider) || extname(entry.path) !== '.jsonl') {
      throw new Error('Only Codex and Claude JSONL activity transcripts are supported.')
    }
    const roots = this.transcriptRoots(entry)
    const file = await openSourceFile(entry.path, roots)
    try {
      const info = await file.stat()
      if (info.mtimeMs < now - WINDOW_MS) {
        return `${entry.provider} transcript last modified before the 7-day window`
      }
      if (entry.ino !== info.ino || (entry.offset ?? 0) > info.size) {
        entry.offset = 0
        entry.tail = Buffer.alloc(0)
      }
      const from = entry.offset ?? 0
      const start = Math.max(from, info.size - MAX_LOG_BYTES)
      let bytes
      bytes = Buffer.alloc(Math.min(MAX_LOG_BYTES, info.size - start))
      const result = await file.read(bytes, 0, bytes.length, start)
      bytes = bytes.subarray(0, result.bytesRead)
      let contents = Buffer.concat([
        start === from ? (entry.tail ?? Buffer.alloc(0)) : Buffer.alloc(0),
        bytes
      ])
      if (start > from) {
        contents = contents.subarray(contents.indexOf(10) + 1)
        this.store.limited = true
      }
      const end = contents.lastIndexOf(10)
      const lines =
        end !== -1
          ? contents
              .subarray(0, end + 1)
              .toString('utf8')
              .split('\n')
          : []
      entry.tail = contents.subarray(end + 1)
      if (entry.tail.length > 1024 * 1024) {
        entry.tail = Buffer.alloc(0)
        this.store.limited = true
      }
      for (const line of lines) {
        const row = parsed(line)
        if (!row) {
          continue
        }
        const at = timestamp(row.timestamp ?? row.ts)
        if (at !== null && at >= now - WINDOW_MS) {
          importTranscriptRow(this.store, entry.id, entry.provider, row, entry.path)
        }
      }
      entry.offset = start + bytes.length
      entry.ino = info.ino
      return `${entry.provider} transcript; ${bytes.length} new bytes read`
    } finally {
      await file.close()
    }
  }

  close() {
    for (const db of this.databases.values()) {
      db.close()
    }
    this.databases.clear()
  }
}
