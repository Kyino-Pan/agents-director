import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RouteEvidence, actionOf } from './route-evidence.mjs'
import { ActivityStore } from './activity-store.mjs'
import { encodeRecorderCache, decodeRecorderCache } from './recorder-cache.mjs'

function probe(store = new ActivityStore()) {
  const owners = new Map()
  let now = Date.now()
  function add(terminal, id, createdAt = now) {
    store.agent(id, { label: 'Same title', createdAt })
    owners.set(terminal, {
      id,
      terminal,
      provider: 'codex',
      since: now,
      first: !owners.has(terminal)
    })
  }
  add('term_a', 'sender')
  add('term_b', 'receiver')
  const routes = new RouteEvidence(
    store,
    (t) => owners.get(t),
    () => now
  )
  function hooks(terminal, command, callId = 'tool-1') {
    const event = { agent: 'codex', tool: 'Bash', input: { command }, terminalId: terminal, callId }
    routes.observe('before', event)
    return (output) =>
      routes.observe('after', {
        ...event,
        output: typeof output === 'string' ? output : JSON.stringify(output)
      })
  }
  return {
    store,
    owners,
    add,
    routes,
    hooks,
    tick(ms) {
      now += ms
      routes.refresh()
    }
  }
}
const send = 'orca orchestration send --to term_b --body "PRIVATE ARG" --subject probe --json'
const check = 'orca orchestration check --terminal term_b'
const accepted = { ok: true, result: { messageId: 'msg_123' } }
const receipt = 'msg_123 status from term_a\n  PRIVATE BODY'
const launch = 'orca agent launch --agent codex --surface terminal --prompt "PRIVATE PROMPT" --json'
const launched = { ok: true, result: { outcome: { kind: 'terminal', handle: 'term_new' } } }

test('public Codex Bash hooks distinguish attempt, acceptance and exact mailbox retrieval', () => {
  const f = probe()
  const finish = f.hooks('term_a', send)
  assert.equal(f.routes.attempts()[0].type, 'Send attempted')
  assert.equal(f.store.messages.size, 0)
  finish(accepted)
  assert.deepEqual(f.routes.attempts(), [])
  const key = 'public-mail:msg_123'
  assert.equal(f.store.messages.get(key).type, 'Send accepted')
  f.tick(130000) // delayed delivery can still confirm a retained arrow
  f.hooks('term_b', check)(receipt)
  assert.equal(f.store.messages.get(key).type, 'Mailbox received')
  assert.equal(f.store.messages.get(key).from, 'sender')
  assert.equal(f.store.messages.get(key).to, 'receiver')
  assert.doesNotMatch(JSON.stringify(f.store.serialize()), /PRIVATE|--to|--body/)
})

test('aliases join on the accepted message id and receiving session, even with out-of-order hooks', () => {
  for (const address of ['bot:Release', 'dispatch:ctx_2', null]) {
    const f = probe()
    const finish = f.hooks('term_a', send.replace('--to term_b', address ? '--to ' + address : ''))
    assert.deepEqual(f.routes.attempts(), [])
    f.hooks(
      'term_b',
      check + ' --json'
    )({ ok: true, result: { messages: [{ id: 'msg_123', body: 'PRIVATE BODY' }] } })
    assert.equal(f.store.messages.get('public-mail:msg_123').type, 'Mailbox input')
    assert.equal(f.store.messages.get('public-mail:msg_123').from, null)
    finish(accepted)
    assert.equal(f.store.messages.get('public-mail:msg_123').to, 'receiver')
  }
})

test('denials, stale owners, different checks, fake receipts and indirect shell commands cannot join lanes', () => {
  for (const command of [
    'echo ' + send,
    send + '; echo fake',
    send + ' | cat',
    send + ' > out',
    send + ' --on elsewhere',
    send.replace('term_b', '$target'),
    send + ' --from term_b',
    send + ' --to term_x',
    send + '\nfalse',
    check + ' --peek',
    check.replace('term_b', 'term_a'),
    launch.replace('launch', 'resume')
  ])
    assert.equal(
      actionOf({
        tool: 'Bash',
        input: { command },
        terminalId: command.startsWith('orca orchestration check') ? 'term_b' : 'term_a'
      }),
      undefined,
      command
    )
  for (const response of [
    { ok: false, result: { messageId: 'msg_123' } },
    'prefix ' + JSON.stringify(accepted),
    { ok: true, result: { warnings: ['msg_123'] } }
  ]) {
    const f = probe()
    f.hooks('term_a', send)(response)
    assert.equal(f.store.messages.size, 0)
    assert.equal(f.routes.attempts().length, 0)
  }
  for (const terminal of ['term_a', 'term_b']) {
    const f = probe()
    const finish = f.hooks('term_a', send)
    f.add(terminal, 'reused')
    finish(accepted)
    assert.equal(f.store.messages.size, 0)
  }
  const f = probe()
  f.hooks('term_a', send)(accepted)
  f.add('term_b', 'another-session')
  f.hooks('term_b', check)(receipt)
  assert.equal([...f.store.messages.values()][0].deliveredAt, undefined)
})
test('fresh launch receipt needs a new public session on that exact terminal; resume and rebind stay distinct', () => {
  for (const outcome of ['fresh', 'old-session', 'reused-handle', 'failed']) {
    const f = probe()
    const finish = f.hooks('term_a', launch)
    finish(outcome === 'failed' ? { ...launched, ok: false } : launched)
    f.add('term_unrelated', 'wrong')
    if (outcome === 'reused-handle') f.add('term_new', 'previous')
    f.add('term_new', 'child', outcome === 'old-session' ? 0 : Date.now() + 1000)
    f.routes.refresh()
    assert.equal(f.store.agents.get('child').parentId, outcome === 'fresh' ? 'sender' : undefined)
    assert.equal(f.store.agents.get('wrong').parentId, undefined)
  }
})
test('attached worker-start maps its exact dispatch without assigning a new parent', () => {
  const f = probe()
  f.hooks(
    'term_a',
    'orca orchestration worker-start --terminal term_b --spec probe --json'
  )({ ok: true, result: { state: 'ready', terminal: 'term_b', dispatchId: 'ctx_2' } })
  f.hooks('term_a', send.replace('term_b', 'dispatch:ctx_2'))(accepted)
  assert.equal(f.store.agents.get('receiver').parentId, undefined)
  assert.equal(f.store.messages.get('public-mail:msg_123').to, 'receiver')
  f.add('term_b', 'replacement')
  f.hooks(
    'term_a',
    send.replace('term_b', 'dispatch:ctx_2')
  )({ ok: true, result: { messageId: 'msg_456' } })
  assert.equal(f.store.messages.size, 1)
})

const plainStart =
  'orca orchestration worker-start --spec-file /absent/probe --worktree current --agent codex'
const plainReady =
  'dispatchId=ctx_new taskId=task_1 runId=run_123 runCreated=true state=ready agent=codex ' +
  'mode=terminal terminal=term_new workspace="/lab/a workspace"'

test('a concise worker-start receipt links a fresh session or binds an attached dispatch', () => {
  const fresh = probe()
  fresh.hooks('term_a', plainStart)(plainReady + '\nNext: end your turn')
  fresh.add('term_new', 'child', Date.now() + 500)
  fresh.routes.refresh()
  assert.equal(fresh.store.agents.get('child').parentId, 'sender')

  const attached = probe()
  attached.hooks(
    'term_a',
    'orca orchestration worker-start --task task_1 --terminal term_b'
  )(plainReady.replace('terminal=term_new', 'terminal=term_b'))
  attached.hooks('term_a', send.replace('term_b', 'dispatch:ctx_new'))(accepted)
  assert.equal(attached.store.agents.get('receiver').parentId, undefined)
  assert.equal(attached.store.messages.get('public-mail:msg_123').to, 'receiver')
})

test('concise worker-start receipts require unambiguous ready terminal fields on the header', () => {
  for (const output of [
    plainReady.replace('state=ready', 'state=outcome_unknown'),
    plainReady.replace('mode=terminal', 'mode=chat'),
    plainReady.replace('mode=terminal ', ''),
    plainReady.replace('taskId=task_1', 'taskId=unknown'),
    plainReady.replace('terminal=term_new ', '') + '\nNext: terminal=term_new',
    plainReady.replace('terminal=term_new ', 'hint="label terminal=term_new" '),
    plainReady + ' terminal=term_other',
    'prefix\n' + plainReady
  ]) {
    const f = probe()
    f.hooks('term_a', plainStart)(output)
    f.add('term_new', 'child', Date.now() + 500)
    f.routes.refresh()
    assert.equal(f.store.agents.get('child').parentId, undefined, output)
    f.hooks('term_a', send.replace('term_b', 'dispatch:ctx_new'))(accepted)
    assert.equal(f.store.messages.size, 0, output)
  }
})

test('an identified new-worktree agent and a duplicated cross-session call ID', () => {
  const f = probe()
  const finish = f.hooks(
    'term_a',
    'orca worktree create --name probe --no-parent --agent codex --json'
  )
  finish({ ok: true, result: { launch: launched.result } })
  f.add('term_new', 'child', Date.now() + 1000)
  f.routes.refresh()
  assert.equal(f.store.agents.get('child').parentId, 'sender')
  const first = f.hooks('term_a', send)
  f.add('term_a', 'replacement')
  const second = f.hooks('term_a', send)
  first(accepted)
  second(accepted)
  assert.deepEqual(f.routes.attempts(), [])
  assert.equal(f.store.messages.size, 0)
})

test('a reply joins only its returned id to an independent local retrieval', () => {
  const command = 'orca orchestration reply --id msg_123 --body-file /absent/PRIVATE --json'
  for (const original of ['observed', 'missing']) {
    for (const order of ['send-first', 'check-first']) {
      const f = probe()
      if (original === 'observed') {
        f.hooks('term_a', send)(accepted)
        f.hooks('term_b', check)(receipt)
      }
      const finish = f.hooks('term_b', command)
      const accept = () => finish({ ok: true, result: { messageId: 'msg_answer' } })
      const collect = () =>
        f.hooks('term_a', 'orca orchestration check')('msg_answer status from term_b')
      if (order === 'send-first') {
        accept()
        assert.equal(f.store.messages.has('public-mail:msg_answer'), false)
        f.tick(2000)
        collect()
      } else {
        collect()
        assert.equal(f.store.messages.get('public-mail:msg_answer').from, null)
        accept()
      }
      const answer = f.store.messages.get('public-mail:msg_answer')
      assert.deepEqual(
        [answer.from, answer.to, answer.type],
        ['receiver', 'sender', 'Mailbox received']
      )
      if (order === 'send-first') assert.equal(answer.deliveredAt - answer.at, 2000)
      if (original === 'observed')
        assert.equal(f.store.messages.get('public-mail:msg_123').from, 'sender')
      collect()
      assert.deepEqual(answer, f.store.messages.get(answer.id))
      assert.equal(f.store.messages.size, original === 'observed' ? 2 : 1)
      assert.doesNotMatch(JSON.stringify(f.store.serialize()), /PRIVATE|--body-file/)
    }
  }
})

test('reply failures, original-id echoes, replays and indirect commands cannot provide a sender', () => {
  const reply = 'orca orchestration reply --id msg_question --body answer'
  for (const [command, result] of [
    [reply, 'messageId=msg_question'],
    [reply + ' --json', { ok: false, result: { messageId: 'msg_answer' } }],
    [reply + ' --retry-request previous', 'messageId=msg_answer'],
    [reply + ' --on remote', 'messageId=msg_answer'],
    [reply + ' --from term_a', 'messageId=msg_answer'],
    [reply.replace('msg_question', 'invalid'), 'messageId=msg_answer'],
    ['sh -c "' + reply + '"', 'messageId=msg_answer'],
    [reply.replace('orca ', '"$OTHER" '), 'messageId=msg_answer'],
    [reply.replace('orca ', '"${ORCA_CLI_COMMAND:-other}" '), 'messageId=msg_answer'],
    [reply.replace('orca ', '"$(command -v orca)" '), 'messageId=msg_answer']
  ]) {
    const f = probe()
    f.hooks('term_b', command)(result)
    f.hooks('term_a', 'orca orchestration check')('msg_answer status from term_b')
    assert.equal(f.store.messages.get('public-mail:msg_answer').from, null)
  }
  const f = probe()
  f.hooks('term_b', reply)('messageId=msg_answer')
  f.tick(120001)
  f.hooks('term_a', 'orca orchestration check')('msg_answer status from term_b')
  assert.equal(f.store.messages.get('public-mail:msg_answer').from, null)
})

test('new and attached task starts retain their different session ownership requirements', () => {
  for (const command of [
    '"$ORCA_CLI_BIN_DIR/orca" orchestration worker-start --spec-file /absent/PRIVATE --task-title scoped --worktree new-child --base-branch main --agent codex --json',
    'orca orchestration worker-start --task task_1 --agent codex --worktree current --json'
  ]) {
    const f = probe()
    f.hooks(
      'term_a',
      command
    )({ ok: true, result: { state: 'ready', dispatchId: 'ctx_new', terminal: 'term_new' } })
    f.add('term_new', 'child', Date.now() + 500)
    f.routes.refresh()
    assert.equal(f.store.agents.get('child').parentId, 'sender')
    assert.doesNotMatch(JSON.stringify(f.store.serialize()), /PRIVATE|--task-title/)
  }
  const f = probe()
  const attach = 'orca orchestration worker-start --task task_2 --terminal term_b --json'
  f.hooks(
    'term_a',
    attach
  )({ ok: true, result: { state: 'ready', dispatchId: 'ctx_reuse', terminal: 'term_b' } })
  f.hooks('term_a', send.replace('term_b', 'dispatch:ctx_reuse'))(accepted)
  assert.equal(f.store.agents.get('receiver').parentId, undefined)
  assert.equal(f.store.messages.get('public-mail:msg_123').to, 'receiver')
  const chat = probe()
  chat.hooks(
    'term_a',
    attach
  )({
    ok: true,
    result: { state: 'ready', mode: 'chat', dispatchId: 'ctx_chat', terminal: 'term_b' }
  })
  chat.hooks('term_a', send.replace('term_b', 'dispatch:ctx_chat'))(accepted)
  assert.equal(chat.store.messages.size, 0)
  for (const flag of ['--item 3', '--retry-request recovery', '--on abroad']) {
    assert.equal(
      actionOf({ tool: 'Bash', input: { command: attach + ' ' + flag }, terminalId: 'term_a' }),
      undefined
    )
  }
})

test('duplicate reply receipts preserve the first time and conflicting senders cannot fill an endpoint', () => {
  const reply = 'orca orchestration reply --id msg_question --body answer'
  for (const duplicate of ['term_b', 'term_c']) {
    const f = probe()
    f.add('term_c', 'other')
    f.hooks('term_b', reply)('messageId=msg_answer')
    f.tick(500)
    f.hooks(duplicate, reply)('messageId=msg_answer')
    f.tick(500)
    f.hooks('term_a', 'orca orchestration check')('msg_answer status from term_b')
    const row = f.store.messages.get('public-mail:msg_answer')
    assert.equal(f.store.messages.size, 1)
    assert.equal(row.from, duplicate === 'term_b' ? 'receiver' : null)
    if (row.from) assert.equal(row.deliveredAt - row.at, 1000)
  }
})

test('a pending question joins its exact consuming check on the coordinator terminal', () => {
  const question = 'orca orchestration ask --question PRIVATE --json'
  const pending = { ok: true, result: { messageId: 'msg_question', pending: true } }
  const consume = 'orca orchestration check --run run_a12bc3 --terminal term_a --json'
  const received = { ok: true, result: { messages: [{ id: 'msg_question' }] } }
  const f = probe()
  f.hooks('term_b', question)(pending)
  for (const command of [
    consume.replace('term_a', 'term_b'),
    consume.replace(' --terminal term_a', ''),
    consume.replace('run_a12bc3', 'run_unbound'),
    consume + ' --peek',
    consume + ' --retry-request replay'
  ])
    f.hooks('term_a', command)(received)
  f.hooks(
    'term_a',
    consume
  )({ ...received, result: { ...received.result, legacyCompatibility: { readOnly: true } } })
  f.hooks('term_a', consume)({ ok: false, error: { code: 'consumer_fenced' } })
  assert.equal(f.store.messages.size, 0)
  f.hooks('term_a', consume)(received)
  const row = f.store.messages.get('public-mail:msg_question')
  assert.deepEqual([row.from, row.to, row.type], ['receiver', 'sender', 'Mailbox received'])
  assert.doesNotMatch(JSON.stringify(f.store.serialize()), /PRIVATE|run_a12bc3/)
  for (const [command, result] of [
    [question + ' --wait', pending],
    [question + ' --resume msg_other', pending],
    [question, { ok: true, result: { messageId: 'msg_question', pending: false } }]
  ]) {
    const probeCase = probe()
    probeCase.hooks('term_b', command)(result)
    probeCase.hooks('term_a', consume)(received)
    assert.equal(probeCase.store.messages.get(row.id).from, null)
  }
})

const answerId = 'public-mail:msg_answer'
const reply = 'orca orchestration reply --id msg_question --body fixture'
const answerReceipt = 'messageId=msg_answer'
const retrieve = 'msg_answer status from term_b'

function reload(store) {
  const saved = new ActivityStore()
  const chunks = encodeRecorderCache(store.serialize())
  saved.restore(decodeRecorderCache({ version: 2 }, chunks))
  return saved
}

test('revoked senders stay unknown across hook order, cache reload and repeated recovery', () => {
  for (const order of ['check-first', 'check-between', 'check-last']) {
    const f = probe()
    f.add('term_c', 'other')
    const checkAnswer = () => f.hooks('term_a', 'orca orchestration check')(retrieve)
    const stored = () => f.store.messages.get(answerId)
    const first = f.hooks('term_b', reply, 'one')
    const second = f.hooks('term_c', reply, 'two')
    if (order === 'check-first') checkAnswer()
    f.tick(5)
    first(answerReceipt)
    if (order === 'check-between') checkAnswer()
    const checkTime = stored()?.deliveredAt
    const older = reload(f.store)
    f.tick(10)
    second(answerReceipt)
    if (order === 'check-last') {
      assert.equal(f.store.snapshot().messages.length, 0)
      checkAnswer()
    }
    const at = checkTime ?? stored().deliveredAt
    const expectInput = (store) => {
      const row = store.messages.get(answerId)
      assert.deepEqual(
        [row.from, row.to, row.type, row.at, row.deliveredAt],
        [null, 'sender', 'Mailbox input', at, at],
        order
      )
    }
    expectInput(f.store)
    f.tick(120001)
    checkAnswer()
    f.hooks('term_b', reply)(answerReceipt)
    const restored = reload(f.store)
    restored.recover(older)
    restored.recover(older)
    expectInput(restored)
    older.recover(restored)
    expectInput(reload(older))
  }
})

test('cold reload distinguishes a unique sender from a conflict before or after retrieval', () => {
  for (const alreadyChecked of [false, true]) {
    const f = probe()
    f.add('term_c', 'other')
    f.hooks('term_a', send)(accepted)
    if (alreadyChecked) f.hooks('term_b', check)(receipt)
    const key = 'public-mail:msg_123'
    const original = f.store.messages.get(key)
    const saved = reload(f.store)
    const g = probe(saved)
    g.add('term_c', 'other')
    g.hooks('term_a', send)(accepted)
    assert.deepEqual(saved.messages.get(key), original)
    g.hooks('term_c', reply)('messageId=msg_123')
    const revoked = reload(saved)
    if (!alreadyChecked) {
      assert.equal(revoked.snapshot().messages.length, 0)
      assert.equal(revoked.messages.get(key).to, null)
      assert.equal(revoked.messages.get(key).deliveredAt, undefined)
    }
    const resumed = probe(revoked)
    revoked.recover(f.store)
    resumed.hooks('term_b', check)(receipt)
    resumed.hooks('term_a', send)(accepted)
    revoked.recover(f.store)
    const row = reload(revoked).messages.get(key)
    assert.deepEqual(
      [row.from, row.to, row.type, row.at],
      [null, 'receiver', 'Mailbox input', row.deliveredAt]
    )
    assert.ok(Number.isFinite(row.deliveredAt))
    if (alreadyChecked) assert.equal(row.deliveredAt, original.deliveredAt)
  }
})

test('a delayed restore reconciles a pending reply with a contrary retained sender', () => {
  const f = probe()
  f.add('term_c', 'other')
  f.hooks('term_a', send)(accepted)
  f.hooks('term_b', check)(receipt)
  const old = reload(f.store)
  const g = probe()
  g.add('term_c', 'other')
  g.hooks('term_c', reply)('messageId=msg_123')
  g.store.recover(old)
  g.routes.reconcileRestoredSenders()
  g.store.recover(old)
  const row = reload(g.store).messages.get('public-mail:msg_123')
  assert.deepEqual(
    [row.from, row.to, row.type, row.at],
    [null, 'receiver', 'Mailbox input', row.deliveredAt]
  )
})
