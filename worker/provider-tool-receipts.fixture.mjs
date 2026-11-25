import { ActivityStore } from './activity-store.mjs'
import { PublicCollector } from './public-collector.mjs'

// Contract fixtures, not captured provider executions. Devin's documented
// tool_response object passes through Orca's public agent.tool.after unchanged:
// https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks#posttooluse
export const launcher = '"${ORCA_CLI_COMMAND:-orca}"'
export const fixtureNow = Date.parse('2026-11-25T08:00:00Z')

export function toolEvent(provider, terminalId, command, callId) {
  return {
    agent: provider,
    workspaceId: 'w',
    terminalId,
    tool: provider === 'devin' ? 'exec' : 'Bash',
    input: { command },
    callId
  }
}

export function toolOutput(provider, result) {
  const output = typeof result === 'string' ? result : JSON.stringify({ ok: true, result })
  return provider === 'devin' ? { success: true, output, error: null } : output
}

export async function providerFixture(source = 'devin', target = 'claude') {
  const f = { now: fixtureNow, sessions: [], calls: [] }
  f.rows = [
    {
      agent: source,
      terminalId: 'term_parent',
      sessionId: 'parent',
      state: 'working',
      stateStartedAt: fixtureNow
    }
  ]
  f.store = new ActivityStore(f.now)
  f.host = {
    async call(method, params) {
      f.calls.push({ method, params })
      if (method === 'workspace.list')
        return {
          workspaces: [{ id: 'w', name: 'Fixture', hostId: 'local', projectId: 'p' }],
          truncated: false
        }
      if (method === 'project.list') return { projects: [], truncated: false }
      if (method === 'agents.list') return { agents: structuredClone(f.rows) }
      if (method === 'agent.listSessions')
        return { sessions: structuredClone(f.sessions), truncated: false }
      throw new Error('Unexpected host call: ' + method)
    }
  }
  f.collector = new PublicCollector(f.store, f.host, () => f.now)
  f.advance = (ms = 1000) => {
    f.now += ms
  }
  f.scan = () => f.collector.scan()
  f.addChild = ({ createdAt = f.now, workspaceId = 'w' } = {}) => {
    f.rows.push({
      agent: target,
      terminalId: 'term_child',
      sessionId: 'child',
      state: 'working',
      stateStartedAt: f.now
    })
    f.sessions.push({
      agent: target,
      sessionId: 'child',
      workspaceId,
      createdAt,
      updatedAt: f.now
    })
  }
  f.observe = (event, result) => {
    f.collector.relations.observe('before', event)
    f.collector.relations.observe('after', {
      ...event,
      output: toolOutput(event.agent, result)
    })
  }
  f.snapshot = () =>
    f.store.snapshot(f.now, { hideShortTasks: false, view: { hours: 1 / 12, end: f.now } })
  await f.scan()
  f.advance()
  return f
}

export async function providerFlow(source, target) {
  const f = await providerFixture(source, target)
  f.observe(
    toolEvent(
      source,
      'term_parent',
      `${launcher} agent launch --agent ${target} --surface terminal --json 2>&1`,
      'launch'
    ),
    { outcome: { kind: 'terminal', handle: 'term_child' } }
  )
  f.addChild()
  f.advance()
  await f.scan()
  f.observe(
    toolEvent(
      source,
      'term_parent',
      `${launcher} orchestration send --to term_child --subject probe --body probe --json 2>&1`,
      'send'
    ),
    { messageId: 'msg_probe' }
  )
  f.advance()
  f.observe(
    toolEvent(
      target,
      'term_child',
      `${launcher} orchestration check --terminal term_child 2>&1`,
      'check'
    ),
    'msg_probe status from term_parent\n  Fixture message'
  )
  f.advance()
  await f.scan()
  return f
}
