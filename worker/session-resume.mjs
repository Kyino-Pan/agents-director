import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  recordedCwd,
  terminalProviderSession,
  validProviderSession
} from './terminal-resume-policy.mjs'

export const workspaceOf = (agent) => agent.workspace?.replace(/^worktree:/, '')

export function resumeIdentity(agent, kind) {
  const target = agent.resumeTarget
  if (!target || target.kind !== kind) {
    throw new Error(
      agent.parentId
        ? 'This internal subagent has no supported standalone resume identity. Open its parent conversation.'
        : 'The original conversation identity and execution host were not recorded; it cannot be resumed safely.'
    )
  }
  if (
    !target.workspace ||
    !target.provider ||
    !(kind === 'chat' ? target.sessionId : target.providerSessionId) ||
    target.workspace !== workspaceOf(agent) ||
    target.provider !== agent.provider ||
    (kind === 'chat'
      ? target.sessionId !== agent.sessionId
      : target.providerSessionId !== agent.providerSessionId)
  ) {
    throw new Error('The recorded resume identity no longer matches this conversation.')
  }
  if (target.executionHostId !== 'local' || target.wslDistro !== null) {
    throw new Error(
      'Resume requires the exact original execution host. Remote, WSL or unknown host routes are not supported.'
    )
  }
  if (
    kind === 'terminal' &&
    !validProviderSession(target.provider, terminalProviderSession(target))
  ) {
    throw new Error('This provider has no supported terminal resume identity in Agents Director.')
  }
  return target
}

// The host resolves the durable workspace, never the currently selected workspace or a panel path.
export async function prepareResume(agent, kind, request, checkDirectory = stat) {
  const target = resumeIdentity(agent, kind)
  const status = await request('status.get', {})
  if (status?.graphStatus !== 'ready') {
    throw new Error('Orca is not ready to verify closed conversations. Resume was not attempted.')
  }
  const required =
    kind === 'chat'
      ? ['agent-session.structured.v1', 'agent-session.structured.reveal.v1']
      : ['agent-session.host-authority.v1', 'agent-session.saved-resume-origin.v1']
  if (!required.every((capability) => status?.capabilities?.includes(capability))) {
    throw new Error('This Orca runtime does not support safe conversation resume. Update Orca.')
  }
  // CLI hook records on Windows do not distinguish native Windows from WSL.
  if (kind === 'terminal' && status.hostPlatform === 'win32') {
    throw new Error(
      'The original Windows or WSL execution route cannot be verified for this terminal.'
    )
  }
  const { worktree } = await request('worktree.show', { worktree: `id:${target.workspace}` }).catch(
    () => {
      throw new Error(
        'Orca could not resolve the original workspace on its host. Resume was not attempted.'
      )
    }
  )
  if (worktree?.id !== target.workspace || worktree.hostId !== target.executionHostId) {
    throw new Error('The original workspace is missing or its execution host no longer matches.')
  }
  const exists =
    isAbsolute(worktree.path ?? '') &&
    (await checkDirectory(worktree.path).catch(() => null))?.isDirectory()
  if (!exists) {
    throw new Error('The original workspace directory is no longer available.')
  }
  // The native ensure RPC does not accept cwd. Never silently resume a work-dir-scoped
  // conversation in a different folder, nor construct a shell cd workaround.
  if (
    kind === 'terminal' &&
    target.cwd !== undefined &&
    (!recordedCwd(target.cwd) || resolve(target.cwd) !== resolve(worktree.path))
  ) {
    throw new Error('The recorded working directory cannot be preserved by this Orca resume API.')
  }
  return target
}
