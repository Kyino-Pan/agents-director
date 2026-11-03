import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityStore } from './activity-store.mjs'
import { OrcaLogReader } from './orca-log-reader.mjs'
import { readProjectCatalog, readDispatchPlacements } from './project-catalog-reader.mjs'

const NOW = Date.parse('2026-11-02T08:00:00Z')

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-activity-projects-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const catalog = new DatabaseSync(join(directory, 'profile-state.db'))
  catalog.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)')
  context.after(() => catalog.close())
  return { directory, catalog }
}

test('coordinator projects survive status-cache loss and terminal closure without inventing activity', async (context) => {
  const { directory, catalog } = await fixture(context)
  const insert = catalog.prepare('INSERT INTO profile_state_documents VALUES (?, ?)')
  insert.run('repos', JSON.stringify([{ id: 'repo', displayName: 'Orca' }]))
  insert.run('projectGroups', JSON.stringify([{ id: 'notes', name: 'Notes' }]))
  insert.run('folderWorkspaces', JSON.stringify([{ id: 'folder', projectGroupId: 'notes' }]))
  insert.run(
    'workspaceSession',
    JSON.stringify({
      tabsByWorktree: { 'repo::/work': [{ id: 'open' }, { id: 'conflicting' }] },
      closedTerminalTabTombstonesByTabId: {
        closed: { worktreeId: 'repo::/work', closedAt: NOW - 1000, reason: 'user' }
      }
    })
  )
  insert.run(
    'workspaceSessionsByHostId',
    JSON.stringify({
      'ssh:host': {
        tabsByWorktree: { 'folder:folder': [{ id: 'remote' }, { id: 'conflicting' }] }
      }
    })
  )
  const db = new DatabaseSync(join(directory, 'orchestration.db'))
  context.after(() => db.close())
  db.exec(`CREATE TABLE runs (id TEXT, coordinator_pane_key TEXT, created_at TEXT);
    CREATE TABLE dispatch_contexts (id TEXT, completed_at TEXT, created_at TEXT);
    CREATE TABLE messages (id TEXT, from_handle TEXT, to_handle TEXT, created_at TEXT, sequence INTEGER);`)
  for (const tab of ['open', 'closed', 'remote', 'conflicting', 'missing']) {
    db.prepare('INSERT INTO runs VALUES (?, ?, ?)').run(tab, `${tab}:leaf`, '2026-11-02 07:00:00')
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
      tab,
      `run:${tab}`,
      `run:${tab}`,
      '2026-11-02 07:00:00',
      1
    )
  }
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  const agents = new Map(store.snapshot(NOW).agents.map((agent) => [agent.runId, agent]))
  for (const tab of ['open', 'closed']) {
    assert.equal(agents.get(tab).workspace, 'repo::/work')
    assert.equal(agents.get(tab).projectName, 'Orca')
  }
  assert.equal(agents.get('remote').projectName, 'Notes')
  for (const tab of ['conflicting', 'missing']) {
    assert.equal(agents.get(tab).workspace, undefined)
    assert.equal(agents.get(tab).projectName, undefined)
  }
  for (const agent of agents.values()) {
    assert.ok(agent.segments.every((segment) => segment.state === 'unknown'))
  }
  assert.equal(store.points.size, 0)
})

test('historical dispatch placement supplies the workspace without relying on a reused pane', async (context) => {
  const { directory } = await fixture(context)
  const db = new DatabaseSync(join(directory, 'orchestration.db'))
  context.after(() => db.close())
  db.exec(`CREATE TABLE runs (id TEXT, created_at TEXT);
    CREATE TABLE dispatch_contexts (id TEXT, run_id TEXT, creator_handle TEXT,
      assignee_handle TEXT, dispatched_at TEXT, completed_at TEXT, created_at TEXT);
    CREATE TABLE messages (created_at TEXT, sequence INTEGER);`)
  assert.equal(readDispatchPlacements(db, ['dispatch']).size, 0)
  db.exec(`CREATE TABLE worker_dispatches (dispatch_id TEXT PRIMARY KEY, worktree_id TEXT);
    INSERT INTO worker_dispatches VALUES ('dispatch', 'repo::/historical/worktree');
    INSERT INTO dispatch_contexts VALUES ('dispatch', 'run', 'coordinator', 'worker',
      '2026-11-02 07:00:00', NULL, '2026-11-02 07:00:00');`)
  const store = new ActivityStore(NOW)
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await reader.scan(NOW)
  const worker = store.snapshot(NOW).agents.find((agent) => agent.dispatchId === 'dispatch')
  assert.equal(worker.workspace, 'repo::/historical/worktree')
  assert.equal(worker.projectId, 'repo:repo')
  assert.equal(worker.segments[0].state, 'unknown')
})

test('saved project catalog groups worktrees across repo placements, groups folder workspaces by project group and refreshes names', async (context) => {
  const { directory, catalog } = await fixture(context)
  const insert = catalog.prepare('INSERT INTO profile_state_documents VALUES (?, ?)')
  insert.run(
    'projects',
    JSON.stringify([
      {
        id: 'github:owner/project',
        displayName: 'Project',
        sourceRepoIds: ['repo-one', 'repo-two']
      }
    ])
  )
  insert.run('projectGroups', JSON.stringify([{ id: 'group', name: 'Folder Project' }]))
  insert.run(
    'folderWorkspaces',
    JSON.stringify([
      { id: 'folder-one', name: 'Notes', folderPath: '/one', projectGroupId: 'group' },
      { id: 'folder-two', name: 'Other', folderPath: '/two', projectGroupId: 'group' }
    ])
  )
  const store = new ActivityStore(NOW)
  for (const [id, workspace, parentId] of [
    ['one', 'repo-one::/work/one'],
    ['two', 'worktree:repo-two::C:\\work\\two'],
    ['folder-one', 'folder:folder-one'],
    ['folder-two', 'folder:folder-two'],
    ['child', undefined, 'one'],
    ['other-project-child', 'repo-other::/work/other', 'one'],
    ['cycle-one', undefined, 'cycle-two'],
    ['cycle-two', undefined, 'cycle-one']
  ]) {
    store.agent(id, { workspace, parentId })
    store.point(id, id, NOW - 1000, 'done', 'journal')
  }
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  const before = await readFile(join(directory, 'profile-state.db'))
  await readProjectCatalog(reader, directory)
  const agents = new Map(store.snapshot(NOW).agents.map((agent) => [agent.id, agent]))
  for (const id of ['one', 'two', 'child']) {
    assert.equal(agents.get(id).projectId, 'github:owner/project')
    assert.equal(agents.get(id).projectName, 'Project')
  }
  assert.equal(agents.get('folder-one').projectId, agents.get('folder-two').projectId)
  assert.equal(agents.get('folder-one').projectName, 'Folder Project')
  assert.equal(agents.get('other-project-child').projectId, 'repo:repo-other')
  assert.equal(agents.get('cycle-one').projectId, undefined)
  assert.deepEqual(await readFile(join(directory, 'profile-state.db')), before)
  assert.throws(
    () =>
      reader
        .database(join(directory, 'profile-state.db'))
        .exec('DELETE FROM profile_state_documents'),
    /readonly|read-only/
  )
  catalog.prepare('UPDATE profile_state_documents SET payload = ? WHERE domain = ?').run(
    JSON.stringify([
      {
        id: 'github:owner/project',
        displayName: 'Renamed',
        sourceRepoIds: ['repo-one', 'repo-two']
      }
    ]),
    'projects'
  )
  await readProjectCatalog(reader, directory)
  assert.equal(
    store.snapshot(NOW).agents.find((agent) => agent.id === 'child').projectName,
    'Renamed'
  )
})

test('catalog follows the selected profile without opening other profiles or traversing paths', async (context) => {
  const { directory, catalog } = await fixture(context)
  await mkdir(join(directory, 'profiles', 'selected'), { recursive: true })
  const selected = new DatabaseSync(join(directory, 'profiles', 'selected', 'profile-state.db'))
  selected.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)')
  selected
    .prepare('INSERT INTO profile_state_documents VALUES (?, ?)')
    .run('repos', JSON.stringify([{ id: 'repo', displayName: 'Selected' }]))
  context.after(() => selected.close())
  catalog
    .prepare('INSERT INTO profile_state_documents VALUES (?, ?)')
    .run('repos', JSON.stringify([{ id: 'repo', displayName: 'Root' }]))
  await writeFile(
    join(directory, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: 'selected' })
  )
  const store = new ActivityStore(NOW)
  store.agent('agent', { workspace: 'repo::/work' })
  store.point('done', 'agent', NOW - 1000, 'done', 'journal')
  const reader = new OrcaLogReader(store, [directory])
  context.after(() => reader.close())
  await readProjectCatalog(reader, directory)
  assert.equal(store.snapshot(NOW).agents[0].projectName, 'Selected')
  await writeFile(
    join(directory, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: '../outside' })
  )
  await readProjectCatalog(reader, directory)
  assert.equal(store.snapshot(NOW).agents[0].projectName, 'Root')
})
