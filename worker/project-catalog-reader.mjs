import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const clean = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 2048) || undefined : undefined
const parsed = (value) => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function readDispatchPlacements(db, dispatchIds) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(worker_dispatches)')
      .all()
      .map((column) => column.name)
  )
  if (!columns.has('dispatch_id')) {
    return new Map()
  }
  const statement = db.prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
  return new Map(
    dispatchIds.map((id) => {
      const row = statement.get(id)
      return [
        id,
        {
          workspace: clean(row?.worktree_id),
          terminalHandle: clean(row?.agent_terminal_handle)
        }
      ]
    })
  )
}

export async function readProjectCatalog(reader, directory) {
  const tabWorkspaces = new Map()
  let profileDirectory = directory
  try {
    const index = parsed(await readFile(join(directory, 'orca-profile-index.json'), 'utf8'))
    const id = clean(index?.activeProfileId)
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
      profileDirectory = join(directory, 'profiles', id)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      reader.store.source(
        join(directory, 'orca-profile-index.json'),
        'error',
        'Cannot read profile index'
      )
    }
  }
  const path = join(profileDirectory, 'profile-state.db')
  await reader.scanSource(path, () => {
    const db = reader.database(path)
    const documents = new Map(
      db
        .prepare(
          "SELECT domain, payload FROM profile_state_documents WHERE domain IN ('repos', 'projects', 'projectGroups', 'folderWorkspaces', 'workspaceSession', 'workspaceSessionsByHostId')"
        )
        .all()
        .map((row) => [row.domain, parsed(row.payload)])
    )
    const recordTab = (tabId, workspace) => {
      const id = clean(tabId)
      const owner = clean(workspace)
      if (id && owner) {
        // Conflicting host copies cannot establish a unique workspace owner.
        tabWorkspaces.set(
          id,
          tabWorkspaces.has(id) && tabWorkspaces.get(id) !== owner ? undefined : owner
        )
      }
    }
    const sessions = [
      documents.get('workspaceSession'),
      ...Object.values(documents.get('workspaceSessionsByHostId') ?? {})
    ]
    for (const session of sessions) {
      for (const [workspace, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            recordTab(tab?.id, workspace)
          }
        }
      }
      for (const [tabId, closed] of Object.entries(
        session?.closedTerminalTabTombstonesByTabId ?? {}
      )) {
        recordTab(tabId, closed?.worktreeId)
      }
    }
    const rows = (domain) => (Array.isArray(documents.get(domain)) ? documents.get(domain) : [])
    const groups = new Map(
      rows('projectGroups')
        .filter((group) => clean(group?.id))
        .map((group) => [group.id, group])
    )
    const groupProject = (id) =>
      id
        ? {
            projectId: `group:${id}`,
            projectName: clean(groups.get(id)?.name) ?? `Project ${id.slice(0, 8)}`
          }
        : null
    for (const repo of rows('repos')) {
      if (clean(repo?.id)) {
        reader.store.projectCatalog.set(
          `repo:${repo.id}`,
          groupProject(clean(repo.projectGroupId)) ?? {
            projectId: `repo:${repo.id}`,
            projectName: clean(repo.displayName) ?? `Project ${repo.id.slice(0, 8)}`
          }
        )
      }
    }
    for (const project of rows('projects')) {
      if (!clean(project?.id) || !Array.isArray(project.sourceRepoIds)) {
        continue
      }
      for (const repoId of project.sourceRepoIds) {
        if (
          clean(repoId) &&
          !reader.store.projectCatalog.get(`repo:${repoId}`)?.projectId?.startsWith('group:')
        ) {
          reader.store.projectCatalog.set(`repo:${repoId}`, {
            projectId: project.id,
            projectName: clean(project.displayName) ?? project.id
          })
        }
      }
    }
    for (const folder of rows('folderWorkspaces')) {
      if (clean(folder?.id)) {
        const project = groupProject(clean(folder.projectGroupId))
        if (project) {
          reader.store.projectCatalog.set(`folder:${folder.id}`, project)
        }
      }
    }
    return 'Project names and workspace membership read from saved catalog'
  })
  return tabWorkspaces
}
