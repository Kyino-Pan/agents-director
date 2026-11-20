import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RouteEvidence, actionOf } from './route-evidence.mjs'
import { ActivityStore } from './activity-store.mjs'

function probe() {
  const store = new ActivityStore()
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
