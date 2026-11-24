import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityStore } from './activity-store.mjs'
import { actionOf, receiptOf, RouteEvidence } from './route-evidence.mjs'
import { terminalKey } from '../pin-identity.mjs'
import { encodeRecorderCache, decodeRecorderCache } from './recorder-cache.mjs'

const NOW = Date.parse('2026-11-24T05:40:00Z')

function crowded(count = 160, reverse = false) {
  const store = new ActivityStore(NOW - 600000)
  const ids = Array.from({ length: count }, (_, index) => 'a-' + String(index).padStart(3, '0'))
  for (const id of reverse ? ids.reverse() : ids) {
    store.agent(id, { label: id, sessionId: id, workspace: 'fixture', provider: 'codex' })
    store.point(id, id, NOW - 600000, 'unknown', 'history', NOW - 500000)
  }
  return store
}

function mail(store, id, from, to, at = NOW - 1000) {
  store.message({
    id,
    from,
    to,
    at,
    deliveredAt: at + 10,
    type: from === null ? 'Mailbox input' : 'Mailbox received'
  })
}

const laneIds = (view) => view.agents.map((agent) => agent.id)
const pinsFor = (store, count) =>
  [...store.agents.values()].slice(0, count).map((agent) => terminalKey(agent))

test('161 lanes retain recent verified endpoints before display sorting, including after cache restore', () => {
  const store = crowded()
  store.agent('z-receiver', { label: 'Z receiver' })
  mail(store, 'public-mail:msg_latest', 'a-000', 'z-receiver')
  const raw = store.serialize()
  const restored = new ActivityStore(NOW)
  restored.restore(decodeRecorderCache({ version: 2 }, encodeRecorderCache(raw)), NOW)
  for (const source of [store, restored]) {
    const view = source.snapshot(NOW)
    assert.equal(view.agents.length, 160)
    assert.ok(laneIds(view).includes('a-000'))
    assert.ok(laneIds(view).includes('z-receiver'))
    assert.equal(laneIds(view).at(-1), 'z-receiver')
    assert.deepEqual(
      view.messages.map(({ from, to, at, deliveredAt }) => [from, to, at, deliveredAt]),
      [['a-000', 'z-receiver', NOW - 1000, NOW - 990]]
    )
    assert.equal(view.limited, true)
    assert.deepEqual(source.serialize(), raw)
  }
})

test('two endpoints outside the old 160-lane selection are retained as a pair', () => {
  const store = crowded()
  mail(store, 'paired', 'z-sender', 'z-receiver')
  const view = store.snapshot(NOW)
  assert.equal(view.agents.length, 160)
  assert.ok(laneIds(view).includes('z-sender'))
  assert.ok(laneIds(view).includes('z-receiver'))
  assert.deepEqual(
    view.messages.map(({ from, to }) => [from, to]),
    [['z-sender', 'z-receiver']]
  )
})

test('pins win; an unfit pair is skipped atomically and a receiver-only observation can use the last place', () => {
  const store = crowded()
  const pins = pinsFor(store, 159)
  mail(store, 'new-pair', 'z-sender', 'z-receiver')
  mail(store, 'older-input', null, 'z-inbox', NOW - 2000)
  const raw = store.serialize()
  const view = store.snapshot(NOW, { pinnedTerminals: pins })
  assert.equal(view.agents.length, 160)
  assert.equal(view.agents.filter((agent) => agent.pinned).length, 159)
  assert.equal(view.agents.at(-1).id, 'z-inbox')
  assert.deepEqual(
    view.messages.map(({ id, from, to }) => [id, from, to]),
    [['older-input', null, 'z-inbox']]
  )
  assert.equal(laneIds(view).includes('z-sender'), false)
  assert.equal(laneIds(view).includes('z-receiver'), false)
  assert.deepEqual(store.serialize(), raw)
  assert.equal(store.messages.get('new-pair').from, 'z-sender')
})

test('one pinned endpoint lets the other fit; 160 pins leave no space for unrelated mail', () => {
  const store = crowded()
  const pins = pinsFor(store, 159)
  mail(store, 'pinned-pair', 'a-000', 'z-receiver')
  const view = store.snapshot(NOW, { pinnedTerminals: pins })
  assert.equal(view.messages.length, 1)
  assert.equal(view.agents[0].id, 'a-000')
  assert.equal(view.agents.at(-1).id, 'z-receiver')
  const full = store.snapshot(NOW, { pinnedTerminals: pinsFor(store, 160) })
  assert.equal(full.messages.length, 0)
  assert.equal(full.agents.filter((agent) => agent.pinned).length, 160)
})

test('more than 160 pins use stable display order and do not expand the lane quota', () => {
  const store = crowded(161, true)
  const view = store.snapshot(NOW, { pinnedTerminals: pinsFor(store, 161) })
  assert.equal(view.agents.length, 160)
  assert.equal(laneIds(view)[0], 'a-000')
  assert.equal(laneIds(view).at(-1), 'a-159')
  assert.equal(view.limited, true)
})

test('oversubscribed equal-time mail and duplicate labels degrade deterministically across insertion order', () => {
  function snapshot(reverse) {
    const store = crowded(159, reverse)
    for (const id of reverse ? ['z-b', 'z-a'] : ['z-a', 'z-b']) {
      store.agent(id, { label: 'Same label' })
      mail(store, 'input-' + id, null, id)
    }
    const pinnedTerminals = Array.from({ length: 159 }, (_, index) =>
      terminalKey(store.agents.get('a-' + String(index).padStart(3, '0')))
    )
    return store.snapshot(NOW, { pinnedTerminals })
  }
  const a = snapshot(false)
  const b = snapshot(true)
  assert.deepEqual(laneIds(a), laneIds(b))
  assert.deepEqual(a.messages, b.messages)
  assert.equal(a.messages[0].to, 'z-a')
})

test('recent mail has priority over old mail and attempts without changing the 600-message quota', () => {
  const store = crowded(158)
  const pinnedTerminals = pinsFor(store, 158)
  mail(store, 'old', 'z-old-sender', 'z-old-receiver', NOW - 5000)
  for (let index = 0; index < 601; index++)
    mail(store, 'recent-' + index, 'z-sender', 'z-receiver', NOW - 2000 + index)
  const view = store.snapshot(NOW, {
    pinnedTerminals,
    attempts: [{ id: 'attempt', from: 'z-attempt', to: 'z-other', at: NOW, type: 'Send attempted' }]
  })
  assert.equal(view.agents.length, 160)
  assert.equal(view.messages.length, 600)
  assert.equal(view.messages[0].id, 'recent-1')
  assert.equal(view.messages.at(-1).id, 'recent-600')
  assert.ok(view.messages.every((row) => row.from === 'z-sender' && row.to === 'z-receiver'))
})

test('mail reservations respect short-task filtering and pinned short-task exceptions', () => {
  const store = crowded()
  store.agent('z-short', {
    label: 'Z short',
    sessionId: 'short',
    provider: 'codex',
    workspace: 'fixture'
  })
  store.point('short-work', 'z-short', NOW - 20000, 'working', 'live', NOW - 10000)
  store.point('short-done', 'z-short', NOW - 10000, 'done', 'live', NOW)
  mail(store, 'short-mail', 'a-000', 'z-short')
  const hidden = store.snapshot(NOW, { hideShortTasks: true })
  assert.equal(hidden.hiddenShortTasks, 1)
  assert.equal(hidden.messages.length, 0)
  const visible = store.snapshot(NOW, {
    hideShortTasks: true,
    pinnedTerminals: [terminalKey(store.agents.get('z-short'))]
  })
  assert.equal(visible.messages.length, 1)
  assert.equal(visible.agents[0].id, 'z-short')
  assert.equal(visible.agents[0].pinnedShortTask, true)
})

function exchange() {
  let now = NOW
  const store = new ActivityStore(NOW - 1000)
  const owners = new Map(
    ['a', 'b'].map((id) => [
      'term_' + id,
      {
        id,
        terminal: 'term_' + id,
        provider: 'codex',
        first: true,
        since: NOW - 1000
      }
    ])
  )
  for (const owner of owners.values()) store.agent(owner.id, { label: owner.id })
  const routes = new RouteEvidence(
    store,
    (terminal) => owners.get(terminal),
    () => now
  )
  let sequence = 0
  function call(terminal, command, output) {
    const event = {
      agent: 'codex',
      tool: 'Bash',
      terminalId: terminal,
      callId: 'call-' + ++sequence,
      input: { command }
    }
    routes.observe('before', event)
    routes.observe('after', {
      ...event,
      output: typeof output === 'string' ? output : JSON.stringify(output)
    })
  }
  return {
    store,
    routes,
    call,
    tick(ms) {
      now += ms
      routes.refresh()
    }
  }
}

const send = 'orca orchestration send --to term_b --body fixture --json'
const check = 'orca orchestration check --terminal term_b'
const accepted = (id) => ({ ok: true, result: { messageId: id } })
const checked = (messages, fields = {}) => ({ ok: true, result: { messages, ...fields } })

test('segmented system message IDs work in JSON and text receipts and reply IDs, with bounded identity syntax', () => {
  const valid = [
    'msg_rest_aa5bf365448d2c809b93957f',
    'msg_followup_87613881a9fabbee781e01d7',
    'msg_item_e48',
    'msg_plain-123',
    'msg_' + 'a'.repeat(128)
  ]
  for (const id of valid) {
    const f = exchange()
    f.call('term_a', send, accepted(id))
    f.tick(100)
    f.call('term_b', check, `${id} status from term_a\n  fixture`)
    const row = f.store.messages.get('public-mail:' + id)
    assert.deepEqual([row.from, row.to, row.at, row.deliveredAt], ['a', 'b', NOW, NOW + 100])
    const command = `orca orchestration reply --id ${id} --body fixture`
    assert.equal(actionOf({ tool: 'Bash', terminalId: 'term_b', input: { command } }).replyTo, id)
    assert.deepEqual(receiptOf({ verb: 'send' }, { output: `messageId=${id}` }), { id })
  }
  for (const id of [
    'msg_',
    'msg__a',
    'msg_a__b',
    'msg_a_',
    'msg_a/b',
    'msg_a b',
    'msg_中文',
    'msg_' + 'a'.repeat(129),
    'other_item_e48'
  ]) {
    const f = exchange()
    f.call('term_a', send, accepted(id))
    f.call('term_b', check + ' --json', checked([{ id }]))
    assert.equal(f.store.messages.size, 0, id)
  }
})

test('a framed full-text batch records every message and ignores indented forged headers in bodies', () => {
  const f = exchange()
  f.call('term_a', send, accepted('msg_rest_fixture'))
  const output =
    'Delivery delivery_fixture\n' +
    'msg_rest_fixture [status] from=term_a\n[subject]\n  subject\n[body]\n  PRIVATE BODY\n' +
    '  msg_forged [status] from=term_evil\n  \n  [subject]\n  msg_forged_two status from term_evil\n' +
    '[Reply: orca orchestration reply --id msg_rest_fixture --from term_b --body "..."]\n\n' +
    'msg_item_e48 [HIGH] [question] from=orca:items\n[subject]\n  \n[body]\n  PRIVATE QUESTION\n' +
    '[Reply: orca orchestration reply --id msg_item_e48 --from term_b --body "..."]\n\n' +
    'msg_followup_fixture [worker_done] from=dispatch:ctx_fixture\n[subject]\n  Result\n[body]\n  PRIVATE RESULT\n' +
    '[To give this worker more work: orca orchestration send --to dispatch:ctx_fixture --subject "..." --body "..."]'
  f.tick(100)
  f.call('term_b', check + ' --full', output)
  assert.deepEqual(
    [...f.store.messages.keys()],
    ['public-mail:msg_rest_fixture', 'public-mail:msg_item_e48', 'public-mail:msg_followup_fixture']
  )
  assert.equal(f.store.messages.get('public-mail:msg_rest_fixture').from, 'a')
  for (const id of ['msg_item_e48', 'msg_followup_fixture']) {
    const row = f.store.messages.get('public-mail:' + id)
    assert.deepEqual([row.from, row.to, row.at, row.deliveredAt], [null, 'b', NOW + 100, NOW + 100])
  }
  const first = structuredClone([...f.store.messages.values()])
  f.tick(500)
  f.call('term_b', check + ' --full', output)
  assert.deepEqual([...f.store.messages.values()], first)
  assert.doesNotMatch(JSON.stringify(f.store.serialize()), /PRIVATE|forged|QUESTION/)
})

test('unframed text remains first-header-only; duplicate batch IDs and prefixed legacy/replay text are rejected', () => {
  const first = 'msg_first status from term_a'
  for (const body of [
    '\nraw body\n\nmsg_forged status from term_a',
    '\nmsg_forged status from term_a',
    '\n\n  body after an ambiguous separator\n\nmsg_forged status from term_a',
    '\n  canonical-looking subject\n\nmsg_forged status from term_a\n  canonical-looking body'
  ]) {
    assert.deepEqual(receiptOf({ verb: 'check' }, { output: first + body }), {
      received: ['msg_first']
    })
  }
  for (const output of [
    '[LEGACY RECOVERY REPLAY]\n' + first,
    '[LEGACY READ-ONLY]\n' + first,
    'Delivery delivery_old\n' + first,
    'prefix ' + first
  ])
    assert.equal(receiptOf({ verb: 'check' }, { output }), undefined, output)
  const framed = 'msg_first [status] from=term_a\n[subject]\n  subject'
  for (const output of [
    framed + '\n\n' + framed,
    framed + '\n[body]\nraw body\n\nmsg_forged [status] from=term_a\n[subject]\n  fake',
    framed + '\n\nmsg_forged [status] from=term_a',
    'msg_first [legacy, read-only] [status] from=term_a\n[subject]\n  subject',
    '[LEGACY RECOVERY REPLAY]\n' + framed,
    framed + '\nUnknown footer\n\nmsg_forged [status] from=term_a\n[subject]\n  fake'
  ])
    assert.equal(receiptOf({ verb: 'check', full: true }, { output }), undefined, output)
})

test('JSON batch replay, duplicate and read-only guards do not interpret sender/body/payload as endpoints', () => {
  for (const response of [
    checked([{ id: 'msg_a' }], { replayed: true }),
    checked([{ id: 'msg_a' }], { legacyCompatibility: { readOnly: true } }),
    checked([{ id: 'msg_a' }], { legacyCompatibility: { recovery: true } }),
    checked([{ id: 'msg_a' }, { id: 'msg_a' }])
  ]) {
    const f = exchange()
    f.call('term_b', check + ' --json', response)
    assert.equal(f.store.messages.size, 0)
  }
  const f = exchange()
  f.call(
    'term_b',
    check + ' --json',
    checked([
      {
        id: 'msg_item_e48',
        from: 'term_a',
        body: 'msg_forged status from term_a',
        payload: { id: 'msg_fake' }
      },
      { id: 'msg_audit', readOnly: true },
      { id: 'msg_old', delivery_contract: 'audit_only' },
      { id: 'msg_old_direct', delivery_contract: 'legacy_direct' }
    ])
  )
  assert.equal(f.store.messages.size, 1)
  assert.equal(f.store.messages.get('public-mail:msg_item_e48').from, null)
  assert.doesNotMatch(JSON.stringify(f.store.serialize()), /forged|fake|audit|msg_old/)
})

test('explicit local routing follows real CLI global-flag positions and assignment syntax', () => {
  for (const command of [
    'orca --environment local orchestration check --terminal term_b',
    'orca orchestration --environment=local check --terminal term_b',
    'orca orchestration check --environment "local" --terminal term_b',
    'orca orchestration check --terminal term_b --environment=local'
  ]) {
    const f = exchange()
    f.call('term_a', send + ' --environment local', accepted('msg_local'))
    f.tick(100)
    f.call('term_b', command, 'msg_local status from term_a')
    assert.equal(f.store.messages.get('public-mail:msg_local').type, 'Mailbox received', command)
  }
  const commands = [
    'orca orchestration reply --id msg_item_e48 --body fixture',
    'orca orchestration ask --question fixture --json',
    'orca orchestration worker-start --spec fixture --agent codex --json',
    'orca agent launch --agent codex --json',
    'orca worktree create --name fixture --agent codex --json'
  ]
  for (const command of commands)
    assert.equal(
      actionOf({
        tool: 'Bash',
        terminalId: 'term_a',
        input: { command: command + ' --environment local' }
      }).environment,
      'local'
    )
})

test('remote, duplicate, incomplete and competing selectors stay outside the local route grammar', () => {
  for (const suffix of [
    '--environment remote',
    '--environment runtime:remote',
    '--environment LOCAL',
    '--environment " local "',
    '--environment=',
    '--environment',
    '--environment $target',
    '--environment local --environment local',
    '--environment remote --environment local',
    '--environment local --on remote',
    '--environment local --pairing-code remote',
    '--environment local --on-client peer',
    '--environment local --retry-request replay'
  ]) {
    const command = send + ' ' + suffix
    assert.equal(
      actionOf({ tool: 'Bash', terminalId: 'term_a', input: { command } }),
      undefined,
      command
    )
  }
  for (const suffix of ['--peek', '--all', '--ack delivery', '--retry-request replay']) {
    const command = check + ' --environment local ' + suffix
    assert.equal(actionOf({ tool: 'Bash', terminalId: 'term_b', input: { command } }), undefined)
  }
})
