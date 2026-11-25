import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionOf } from './route-evidence.mjs'
import {
  launcher,
  providerFixture,
  providerFlow,
  toolEvent,
  toolOutput
} from './provider-tool-receipts.fixture.mjs'

test('contract-shaped provider hooks retain fresh creation, acceptance and ordinary retrieval for every source and target', async () => {
  for (const source of ['codex', 'claude', 'devin']) {
    for (const target of ['codex', 'claude', 'devin']) {
      const f = await providerFlow(source, target)
      const snapshot = f.snapshot()
      const child = snapshot.agents.find((agent) => agent.sessionId === 'child')
      const parent = snapshot.agents.find((agent) => agent.sessionId === 'parent')
      assert.equal(child.parentId, parent.id, `${source} → ${target}`)
      assert.equal(child.provider, target)
      assert.equal(parent.provider, source)
      assert.deepEqual(
        snapshot.messages.map((mail) => [
          mail.from,
          mail.to,
          mail.type,
          mail.deliveredAt - mail.at
        ]),
        [[parent.id, child.id, 'Mailbox received', 1000]]
      )
      assert.ok(
        snapshot.agents.every((agent) =>
          agent.segments.some((segment) => segment.state === 'working')
        )
      )
      assert.ok(
        f.calls.every(({ method }) =>
          ['workspace.list', 'project.list', 'agents.list', 'agent.listSessions'].includes(method)
        )
      )
      assert.doesNotMatch(
        JSON.stringify(f.store.serialize()),
        /Fixture message|--body|ORCA_CLI_COMMAND|callId|success/
      )
    }
  }
})

test('literal launcher variants and one final fd duplication preserve argument quoting', () => {
  for (const executable of ['orca', '"$ORCA_CLI_BIN_DIR/orca"', '"$ORCA_CLI_COMMAND"', launcher]) {
    for (const suffix of ['', ' 2>&1', '\t2>&1\t']) {
      const event = toolEvent(
        'devin',
        'term_parent',
        `${executable} orchestration send --to term_child --subject probe --body 'quoted 2>&1 ; $(literal)' --json${suffix}`,
        'send'
      )
      assert.equal(actionOf(event)?.target, 'term_child')
      assert.equal(actionOf({ ...event, agent: 'claude', tool: 'Bash' })?.verb, 'send')
    }
  }
  assert.equal(
    actionOf(toolEvent('codex', 'term_parent', 'orca orchestration check', 'call'))?.verb,
    'check'
  )
  assert.equal(
    actionOf({
      ...toolEvent('devin', 'term_parent', 'orca orchestration check', 'call'),
      agent: 'codex'
    }),
    undefined
  )
})

test('launcher spelling never enables wrappers, arbitrary expansion, extra commands or other redirections', () => {
  const command = `${launcher} orchestration send --to term_child --subject probe --body probe --json`
  for (const value of [
    command + '; true',
    command + ' && true',
    command + ' || true',
    command + ' | cat',
    command + '\ntrue',
    command + ' &',
    command + ' > file',
    command + ' >> file',
    command + ' 1>&2',
    command + ' 2>file',
    command + ' <file',
    command + ' 2>&1 2>&1',
    command + ' 2>&1 --full',
    command + ' 2>&1; true',
    command + ' 2>&1\n',
    command.replace(launcher, 'env orca'),
    command.replace(launcher, 'sh -c'),
    command.replace(launcher, '"$(command -v orca)"'),
    command.replace(launcher, '"$OTHER"'),
    command.replace(launcher, '"${ORCA_CLI_COMMAND:-other}"'),
    command.replace(launcher, '"${ORCA_CLI_COMMAND:-$(orca)}"'),
    command.replace(launcher, '"${ORCA_CLI_COMMAND:=orca}"'),
    command.replace(launcher, '$ORCA_CLI_COMMAND'),
    command.replace('term_child', '$target'),
    command + ' --from term_child',
    command + ' --environment remote',
    command + ' --on remote',
    command.replace('--body probe', '--body'),
    command.replace('--body probe', '--body=2>&1')
  ])
    assert.equal(actionOf(toolEvent('devin', 'term_parent', value, 'call')), undefined, value)
})

test('Devin requires a successful documented response object and the CLI success receipt inside it', async () => {
  const ok = JSON.stringify({ ok: true, result: { messageId: 'msg_probe' } })
  for (const output of [
    ok,
    { output: ok },
    { success: false, output: ok, error: null },
    { success: 'true', output: ok, error: null },
    { success: true, output: ok, error: 'failed' },
    { success: true, output: ok, error: null, is_error: true },
    { success: true, output: { stdout: ok }, error: null },
    {
      success: true,
      output: JSON.stringify({ ok: false, result: { messageId: 'msg_probe' } }),
      error: null
    },
    { success: true, output: 'prefix ' + ok, error: null },
    { success: true, output: 'messageId=invalid', error: null },
    {
      success: true,
      output: JSON.stringify({ ok: true, result: { replayed: true, messageId: 'msg_probe' } }),
      error: null
    }
  ]) {
    const f = await providerFixture()
    f.addChild()
    await f.scan()
    const event = toolEvent(
      'devin',
      'term_parent',
      `${launcher} orchestration send --to term_child --subject probe --body probe --json 2>&1`,
      'send'
    )
    f.collector.relations.observe('before', event)
    f.collector.relations.observe('after', { ...event, output })
    assert.equal(f.store.messages.size, 0, JSON.stringify(output))
  }
})

test('missing phases, call ids, ownership and a check at the wrong terminal cannot join endpoints', async () => {
  for (const variant of [
    'no-before',
    'no-after',
    'missing-call',
    'other-call',
    'other-provider',
    'other-terminal',
    'changed-target',
    'changed-session'
  ]) {
    const f = await providerFixture()
    f.addChild()
    await f.scan()
    const event = toolEvent(
      'devin',
      'term_parent',
      `${launcher} orchestration send --to term_child --subject probe --body probe --json 2>&1`,
      'send'
    )
    if (variant === 'missing-call') delete event.callId
    if (variant !== 'no-before') f.collector.relations.observe('before', event)
    const after = { ...event, output: toolOutput('devin', { messageId: 'msg_probe' }) }
    if (variant === 'other-call') after.callId = 'another'
    if (variant === 'other-provider') after.agent = 'claude'
    if (variant === 'other-terminal') after.terminalId = 'term_child'
    if (variant === 'changed-target')
      after.input = { command: event.input.command.replace('term_child', 'term_other') }
    if (variant === 'changed-session') {
      f.rows[0].sessionId = 'replaced'
      await f.scan()
    }
    if (variant !== 'no-after') f.collector.relations.observe('after', after)
    assert.equal(f.store.messages.size, 0, variant)
  }
  const f = await providerFixture()
  f.addChild()
  await f.scan()
  f.observe(
    toolEvent(
      'devin',
      'term_parent',
      `${launcher} orchestration send --to term_child --body probe --subject probe --json 2>&1`,
      'send'
    ),
    { messageId: 'msg_probe' }
  )
  f.observe(
    toolEvent(
      'claude',
      'term_child',
      `${launcher} orchestration check --terminal term_other 2>&1`,
      'bad-check'
    ),
    'msg_probe status from term_parent'
  )
  assert.equal(f.snapshot().messages[0].type, 'Send accepted')
  f.observe(
    toolEvent(
      'claude',
      'term_child',
      `${launcher} orchestration check --terminal term_child 2>&1`,
      'check'
    ),
    'msg_probe status from term_parent'
  )
  assert.equal(f.snapshot().messages[0].type, 'Mailbox received')
})

test('failed, replayed, audit-only and different-id Devin retrieval cannot confirm an accepted mail', async () => {
  for (const output of [
    { success: false, output: 'msg_probe status from term_parent', error: 'failed' },
    toolOutput('devin', { messages: [{ id: 'msg_probe' }], replayed: true }),
    toolOutput('devin', { messages: [{ id: 'msg_probe' }], cancelled: true }),
    toolOutput('devin', { messages: [{ id: 'msg_probe', readOnly: true }] }),
    toolOutput('devin', { messages: [{ id: 'msg_probe', delivery_contract: 'audit_only' }] }),
    toolOutput('devin', { messages: [{ id: 'msg_other' }] })
  ]) {
    const f = await providerFixture('claude', 'devin')
    f.addChild()
    await f.scan()
    f.observe(
      toolEvent(
        'claude',
        'term_parent',
        `${launcher} orchestration send --to term_child --subject probe --body probe --json 2>&1`,
        'send'
      ),
      { messageId: 'msg_probe' }
    )
    const event = toolEvent(
      'devin',
      'term_child',
      `${launcher} orchestration check --terminal term_child --json 2>&1`,
      'check'
    )
    f.collector.relations.observe('before', event)
    f.collector.relations.observe('after', { ...event, output })
    assert.equal(f.store.messages.get('public-mail:msg_probe').type, 'Send accepted')
  }
})

test('attach, resume, old creation and workspace mismatch never become a new child', async () => {
  for (const variant of ['attach', 'resume', 'old', 'wrong-workspace', 'chat', 'failed-launch']) {
    const f = await providerFixture('devin', 'claude')
    if (variant === 'attach') {
      f.addChild()
      await f.scan()
      f.advance()
    }
    const command =
      variant === 'attach'
        ? `${launcher} orchestration worker-start --terminal term_child --spec probe --json 2>&1`
        : variant === 'resume'
          ? `${launcher} agent resume --agent claude --session child --json 2>&1`
          : `${launcher} agent launch --agent claude --surface ${variant === 'chat' ? 'chat' : 'terminal'} --json 2>&1`
    const event = toolEvent('devin', 'term_parent', command, 'launch')
    const result =
      variant === 'attach'
        ? { state: 'ready', terminal: 'term_child', dispatchId: 'ctx_attached', mode: 'terminal' }
        : { outcome: { kind: 'terminal', handle: 'term_child' } }
    if (variant === 'failed-launch') {
      f.collector.relations.observe('before', event)
      f.collector.relations.observe('after', {
        ...event,
        output: {
          success: false,
          output: JSON.stringify({ ok: true, result }),
          error: 'launch failed'
        }
      })
    } else f.observe(event, result)
    if (variant !== 'attach')
      f.addChild({
        createdAt: variant === 'old' ? f.now - 60000 : f.now,
        workspaceId: variant === 'wrong-workspace' ? 'other' : 'w'
      })
    f.advance()
    await f.scan()
    assert.equal(f.snapshot().agents.filter((agent) => agent.parentId).length, 0, variant)
    if (variant === 'attach') {
      f.observe(
        toolEvent(
          'devin',
          'term_parent',
          `${launcher} orchestration send --to dispatch:ctx_attached --subject probe --body probe --json 2>&1`,
          'send'
        ),
        { messageId: 'msg_probe' }
      )
      assert.equal(f.snapshot().messages[0].type, 'Send accepted')
    }
  }
})
