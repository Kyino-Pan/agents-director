import { join } from 'node:path'
import { WINDOW_MS, timestamp } from './activity-store.mjs'
import { readDispatchPlacements } from './project-catalog-reader.mjs'
import { SessionRouting } from './session-routing.mjs'

const clean = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 2048) || undefined : undefined

export function readOrchestration(reader, directory, now, tabWorkspaces = new Map()) {
  const db = reader.database(join(directory, 'orchestration.db'))
  const runs = db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 1000').all()
  let routing = new SessionRouting(reader.store)
  const runByAddress = new Map()
  const coordinator = (run) => ({
    handle: run.coordinator_handle,
    paneKey: run.coordinator_pane_key,
    sessionId: run.coordinator_orca_session_id
  })
  for (const run of runs) {
    runByAddress.set(`run:${run.id}`, run)
    const id = routing.resolve(coordinator(run), timestamp(run.created_at), `run:${run.id}`)
    routing.bind(`run:${run.id}`, id, {
      label: clean(run.objective) ?? `Run ${run.id.slice(0, 8)}`,
      labelSource: clean(run.objective) ? 'objective' : 'fallback',
      runId: run.id,
      sessionId: clean(run.coordinator_orca_session_id),
      paneKey: clean(run.coordinator_pane_key),
      workspace: tabWorkspaces.get(clean(run.coordinator_pane_key)?.split(':')[0]),
      terminalHandle: clean(run.coordinator_handle)
    })
  }
  const endpoint = (handle, at, paneKey) => {
    const direct = runByAddress.get(handle)
    const owner = !direct && routing.owner(handle, paneKey, at)
    if (owner) {
      return owner
    }
    const run =
      direct ??
      runs.find(
        (candidate) =>
          handle && candidate.coordinator_handle === handle && timestamp(candidate.created_at) <= at
      )
    if (run) {
      return routing.resolve(coordinator(run), at, `run:${run.id}`)
    }
    return routing.resolve({ handle, paneKey }, at)
  }
  const dispatches = db
    .prepare(`SELECT * FROM dispatch_contexts
    WHERE completed_at IS NULL OR datetime(completed_at) >= datetime(?) ORDER BY created_at DESC LIMIT 1000`)
    .all(new Date(now - WINDOW_MS).toISOString())
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.id, dispatch]))
  const placements = readDispatchPlacements(db, [...dispatchById.keys()])
  const taskColumns = new Set(
    db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((column) => column.name)
  )
  const taskNames = new Map()
  if (taskColumns.has('id') && (taskColumns.has('display_name') || taskColumns.has('task_title'))) {
    const statement = db.prepare('SELECT * FROM tasks WHERE id = ?')
    for (const taskId of new Set(dispatches.map((dispatch) => dispatch.task_id).filter(Boolean))) {
      const task = statement.get(taskId)
      taskNames.set(taskId, clean(task?.display_name) ?? clean(task?.task_title))
    }
  }
  for (const dispatch of dispatches) {
    const placement = placements.get(dispatch.id)
    const terminalHandle = clean(dispatch.assignee_handle) ?? placement?.terminalHandle
    const dispatchFailed = ['failed', 'circuit_broken'].includes(dispatch.status)
    const aliases = [
      terminalHandle,
      dispatch.assignee_pane_key ? `pane:${dispatch.assignee_pane_key}` : null,
      dispatch.assignee_orca_session_id
        ? `orca_session_id:${dispatch.assignee_orca_session_id}`
        : null
    ].filter(Boolean)
    const start = timestamp(dispatch.dispatched_at)
    const end = timestamp(dispatch.completed_at)
    const created = timestamp(dispatch.created_at) ?? start
    const parent =
      dispatch.creator_dispatch_id && dispatchById.has(dispatch.creator_dispatch_id)
        ? reader.store.agent(`dispatch:${dispatch.creator_dispatch_id}`)
        : dispatch.creator_orca_session_id
          ? routing.resolve({ sessionId: dispatch.creator_orca_session_id }, created)
          : dispatch.creator_handle || dispatch.creator_pane_key
            ? endpoint(dispatch.creator_handle, created, dispatch.creator_pane_key)
            : endpoint(`run:${dispatch.run_id}`, created)
    const id = reader.store.agent(
      `dispatch:${dispatch.id}`,
      {
        label: `Worker ${dispatch.id.slice(0, 8)}`,
        labelSource: 'fallback',
        ...(taskNames.get(dispatch.task_id)
          ? { label: taskNames.get(dispatch.task_id), labelSource: 'task' }
          : {}),
        runId: dispatch.run_id,
        dispatchId: dispatch.id,
        dispatchFailed,
        taskId: clean(dispatch.task_id),
        workspace: placement?.workspace,
        sessionId: clean(dispatch.assignee_orca_session_id),
        paneKey: clean(dispatch.assignee_pane_key),
        terminalHandle,
        ...(dispatch.creator_handle !== dispatch.assignee_handle
          ? {
              parentId: reader.store.agent(parent),
              spawnedAt: start ?? timestamp(dispatch.created_at)
            }
          : {})
      },
      aliases
    )
    // Dispatch assignment proves a task was assigned, not that its agent was continuously working.
    if (start !== null) {
      reader.store.point(`dispatch:${dispatch.id}:start`, id, start, 'unknown', 'orchestration')
    }
    if (end !== null) {
      reader.store.point(
        `dispatch:${dispatch.id}:end`,
        id,
        end,
        dispatchFailed ? 'unknown' : 'done',
        'orchestration'
      )
    }
  }
  routing = new SessionRouting(reader.store)
  const messages = db
    .prepare(`SELECT * FROM messages WHERE datetime(created_at) >= datetime(?)
    ORDER BY sequence DESC LIMIT 3000`)
    .all(new Date(now - WINDOW_MS).toISOString())
  for (const message of messages) {
    reader.store.message({
      id: `message:${directory}:${message.id}`,
      from: endpoint(message.from_handle, timestamp(message.created_at), message.sender_pane_key),
      to: endpoint(message.to_handle, timestamp(message.created_at)),
      at: timestamp(message.created_at),
      type: clean(message.type) ?? 'status',
      subject: message.subject,
      body: message.body,
      ...(timestamp(message.delivered_at) !== null
        ? { deliveredAt: timestamp(message.delivered_at) }
        : {})
    })
  }
  if (messages.length === 3000 || dispatches.length === 1000 || runs.length === 1000) {
    reader.store.limited = true
  }
  return `${messages.length} messages and ${dispatches.length} dispatches in the 7-day window`
}
