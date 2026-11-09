import { resolve } from 'node:path'
import { defaultDataDirectory } from './orca-log-reader.mjs'
import { createSessionTabClient, navigateSessionTab } from './session-tab-client.mjs'
import { prepareResume, workspaceOf } from './session-resume.mjs'

const runCli = async (args) => {
  const { runTerminalCli } = await import('../dist/terminal-cli.mjs').catch(() => {
    throw new Error('Terminal navigation is unavailable in this plugin build.')
  })
  return runTerminalCli(args)
}

const ownsConversation = (tab, agent) =>
  tab.type === 'terminal' &&
  tab.agentStatus?.agentType === agent.provider &&
  tab.agentStatus?.providerSession?.id === agent.providerSessionId &&
  tab.agentStatus?.providerSession?.key === (agent.resumeTarget?.providerSessionKey ?? 'session_id')

const isLive = (terminal) =>
  terminal.connected &&
  !terminal.orphaned &&
  (terminal.verdict === undefined || terminal.verdict === 'live')

async function currentInventory(agent, request) {
  const workspace = workspaceOf(agent)
  const tabs = await request('session.tabs.list', { worktree: `id:${workspace}` })
  const terminals = await request('terminal.list', {
    worktree: `id:${workspace}`,
    limit: 256,
    includePreview: false,
    includeVisualLayouts: false,
    requireFreshPtyLiveness: true
  })
  if (
    tabs?.worktree !== workspace ||
    !Array.isArray(tabs.tabs) ||
    !Array.isArray(terminals?.terminals) ||
    terminals.truncated
  ) {
    throw new Error(
      'Orca could not verify the current conversation inventory in its recorded workspace.'
    )
  }
  const owners = tabs.tabs.filter((tab) => ownsConversation(tab, agent))
  const matches = terminals.terminals.filter(
    (terminal) =>
      terminal.worktreeId === workspace &&
      owners.some(
        (tab) =>
          tab.terminal === terminal.handle &&
          tab.parentTabId === terminal.tabId &&
          tab.leafId === terminal.leafId
      )
  )
  if (owners.length > 1 || matches.length > 1) {
    throw new Error(
      'More than one terminal claims this conversation; open it in Orca to resolve ownership.'
    )
  }
  return { tabs: tabs.tabs, terminals, owners, terminal: matches[0] }
}

export function createTerminalNavigator(
  store,
  directories,
  command = runCli,
  navigateChat = navigateSessionTab,
  connect = createSessionTabClient,
  checkDirectory
) {
  let pending = false
  // Keep uncertain mutations across clicks and panel instances until the exact live
  // conversation owner is verified. The host additionally deduplicates by identity.
  const resumeAttempts = new Set()
  return async (input) => {
    if (pending) {
      throw new Error('An agent navigation is already in progress.')
    }
    const agent = store.agents.get(input?.agentId)
    if (!agent) {
      throw new Error('No navigation identity was recorded for this agent.')
    }
    if (directories.length !== 1 || resolve(directories[0]) !== resolve(defaultDataDirectory())) {
      throw new Error('Agent navigation and resume are unavailable for imported data directories.')
    }
    const identity = JSON.stringify([
      workspaceOf(agent),
      agent.provider,
      agent.sessionId ?? agent.providerSessionId
    ])
    const beforeResume = () => {
      if (resumeAttempts.has(identity)) {
        throw new Error(
          'Resume was already requested for this conversation. Inspect its original workspace in Orca; another session will not be launched.'
        )
      }
      resumeAttempts.add(identity)
    }
    const ownerObserved = () => resumeAttempts.delete(identity)
    pending = true
    try {
      if (
        agent.sessionId &&
        (agent.resumeTarget?.kind === 'chat' ||
          !agent.terminalHandle ||
          agent.paneKey?.startsWith('structured-agent-session-'))
      ) {
        return await navigateChat(
          agent,
          directories[0],
          connect,
          beforeResume,
          checkDirectory,
          ownerObserved
        )
      }
      if (!agent.workspace || !agent.provider || !agent.providerSessionId) {
        throw new Error(
          agent.parentId
            ? 'This internal subagent has no supported standalone resume identity. Open its parent conversation.'
            : 'No provider conversation identity and original workspace were recorded for this agent.'
        )
      }
      const request = await connect(directories[0])
      let inventory = await currentInventory(agent, request)
      let terminal = inventory.terminal
      if (
        terminal &&
        agent.resumeTarget?.executionHostId &&
        terminal.executionHostId !== agent.resumeTarget.executionHostId
      ) {
        throw new Error('The current terminal execution host no longer matches this conversation.')
      }
      if (!terminal || !isLive(terminal)) {
        if (inventory.owners.length && (!terminal || terminal.verdict !== 'exited')) {
          throw new Error(
            'This terminal is disconnected or its exit is unverified; resume was not attempted.'
          )
        }
        const uncertainAddress = inventory.tabs.some(
          (tab) =>
            tab.type === 'terminal' &&
            (tab.terminal === agent.terminalHandle ||
              `${tab.parentTabId}:${tab.leafId}` === agent.paneKey) &&
            !tab.agentStatus?.providerSession?.id
        )
        const scope = inventory.terminals.hostScope
        if (
          uncertainAddress ||
          !scope?.hostIds?.includes('local') ||
          !Array.isArray(scope.omittedHostIds) ||
          scope.omittedHostIds.includes('local')
        ) {
          throw new Error(
            'Orca cannot verify that this conversation is closed on its original host.'
          )
        }
        const target = await prepareResume(agent, 'terminal', request, checkDirectory)
        beforeResume()
        const result = await request('terminal.ensureAgentSession', {
          kind: 'explicit',
          resumeOrigin: 'saved',
          worktree: `id:${target.workspace}`,
          agent: target.provider,
          providerSession: { key: target.providerSessionKey, id: target.providerSessionId },
          presentation: 'background'
        })
        if (
          !['created', 'adopted'].includes(result?.disposition) ||
          result.terminal?.worktreeId !== workspaceOf(agent) ||
          result.terminal.executionHostId !== target.executionHostId
        ) {
          throw new Error(
            'Orca did not confirm resume in the original workspace and host. Inspect that workspace before trying again.'
          )
        }
        // A launch receipt alone does not prove conversation ownership.
        inventory = await currentInventory(agent, request)
        terminal = inventory.terminal
        if (!terminal || terminal.handle !== result.terminal.handle || !isLive(terminal)) {
          throw new Error(
            'Resume was requested, but its conversation ownership is not confirmed yet. Open the original workspace in Orca.'
          )
        }
      }
      const { terminal: current } = await command(['show', '--terminal', terminal.handle])
      if (
        !current ||
        !isLive(current) ||
        current.handle !== terminal.handle ||
        current.worktreeId !== terminal.worktreeId ||
        current.executionHostId !== terminal.executionHostId ||
        current.tabId !== terminal.tabId ||
        current.leafId !== terminal.leafId
      ) {
        throw new Error('The terminal address no longer matches this conversation.')
      }
      // Recheck after resolving the handle: panes can be reused without closing.
      const verified = await currentInventory(agent, request)
      if (
        verified.terminal?.handle !== terminal.handle ||
        verified.terminal.executionHostId !== terminal.executionHostId ||
        !isLive(verified.terminal)
      ) {
        throw new Error('The terminal no longer belongs to this conversation.')
      }
      // Ownership settles the resume even if desktop focus subsequently fails.
      ownerObserved()
      const { focus } = await command(['switch', '--terminal', terminal.handle])
      if (!focus?.navigated) {
        throw new Error('Orca could not show this terminal in the current desktop.')
      }
      return { navigated: true }
    } finally {
      pending = false
    }
  }
}
