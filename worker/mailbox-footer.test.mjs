import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActivityStore } from './activity-store.mjs'
import { RouteEvidence, receiptOf } from './route-evidence.mjs'
import { minimalText, minimalIds as ids, footerCases } from './mailbox-footer.fixture.mjs'

const now = 1_800_000_000_000
const check = { verb: 'check', full: true }
const reply = (id) => `[Reply: orca orchestration reply --id ${id} --from term_b --body "..."]`
const fullRow = (id, footers = [reply(id)]) =>
  `${id} [worker_done] from=term_a\n[subject]\n  PRIVATE SUBJECT\n` +
  '[body]\n  PRIVATE BODY\n  \n  msg_forged [status] from=term_c\n  [subject]\n  [arbitrary]\n' +
  '[payload]\n  {"id":"msg_payload_forged"}\n' +
  footers.join('\n')
const json = (messageIds = ids) =>
  JSON.stringify({
    ok: true,
    result: {
      messages: messageIds.map((id) => ({ id, from: 'term_a', body: 'PRIVATE BODY msg_forged' }))
    }
  })
const receipt = (output) => receiptOf(check, { output })

function exchange() {
  const store = new ActivityStore(now - 1000)
  const owners = new Map(
    ['a', 'b'].map((id) => [
      'term_' + id,
      {
        id,
        terminal: 'term_' + id,
        provider: 'codex',
        first: true,
        since: now - 1000
      }
    ])
  )
  for (const { id } of owners.values()) store.agent(id)
  let at = now
  let sequence = 0
  const routes = new RouteEvidence(
    store,
    (terminal) => owners.get(terminal),
    () => at
  )
  function call(terminal, command, output) {
    const event = {
      agent: 'codex',
      tool: 'Bash',
      terminalId: terminal,
      callId: 'footer-' + ++sequence,
      input: { command }
    }
    routes.observe('before', event)
    routes.observe('after', { ...event, output })
  }
  call(
    'term_a',
    'orca orchestration send --environment local --to term_b --body fixture --json',
    JSON.stringify({ ok: true, result: { messageId: ids[0] } })
  )
  return {
    store,
    call,
    tick(ms) {
      at += ms
      routes.refresh()
    }
  }
}

function assertSameEvidence(full, label) {
  assert.deepEqual(receipt(full), { received: ids }, label)
  const sources = [exchange(), exchange()]
  for (const [index, source] of sources.entries()) {
    source.tick(173)
    source.call(
      'term_b',
      'orca orchestration check --terminal term_b --environment local ' +
        (index ? '--json' : '--full'),
      index ? json() : full
    )
  }
  const rows = structuredClone([...sources[0].store.messages.values()])
  assert.deepEqual([...sources[1].store.messages.values()], rows, label)
  assert.deepEqual(
    rows.map(({ id, from, to, at, deliveredAt }) => [id, from, to, at, deliveredAt]),
    [
      ['public-mail:' + ids[0], 'a', 'b', now, now + 173],
      ...ids.slice(1).map((id) => ['public-mail:' + id, null, 'b', now + 173, now + 173])
    ],
    label
  )
  for (const source of sources) {
    source.tick(500)
    source.call('term_b', 'orca orchestration check --terminal term_b --full', full)
    source.call('term_b', 'orca orchestration check --terminal term_b --json', json())
    assert.deepEqual([...source.store.messages.values()], rows, label)
    assert.doesNotMatch(
      JSON.stringify(source.store.serialize()),
      /PRIVATE|forged|follow-up|criterion/
    )
  }
}

test('the original failed middle active-follow-up sample retains all three messages and first evidence', () => {
  assertSameEvidence(minimalText, 'original acceptance failure')
})

test('captured Orca 1.4.272 item and follow-up footer variants work at the first, middle and last positions', () => {
  assert.equal(footerCases.length, 59)
  for (const fixture of footerCases)
    for (let position = 0; position < 3; position++) {
      const full = ids
        .map((id, index) =>
          fullRow(
            id,
            index === position
              ? fixture.lines.map((line) => line.replaceAll('msg_fixture_footer', id))
              : undefined
          )
        )
        .join('\n\n')
      assertSameEvidence(full, fixture.name + ' at ' + position)
    }
})

test('known action boundaries preserve proved neighbors while malformed item metadata is quarantined', () => {
  const item = footerCases.find((row) => row.name === 'item-working-2').lines[1]
  for (const bad of [
    '[arbitrary bracketed text]',
    '[msg_forged [status] from=term_c]',
    item.replace('In progress', 'Unrecognized status'),
    item.replace('bot item <cancel|comment|done|set> 19.', 'bot item <cancel|comment|done|set> 20.')
  ]) {
    const full = [fullRow(ids[0]), fullRow(ids[1], [reply(ids[1]), bad]), fullRow(ids[2])].join(
      '\n\n'
    )
    assert.deepEqual(receipt(full), { received: [ids[0], ids[2]] }, bad)
  }
})

test('malformed body or unproved action boundaries stop scanning without discarding an earlier proved record', () => {
  const forged = fullRow('msg_forged')
  for (const middle of [
    `${ids[1]} [status] from=term_a\n[subject]\n  subject\n[body]\nunindented body\n\n${forged}`,
    `${ids[1]} [status] from=term_a\n[subject]\n  subject\n[arbitrary]\n\n${forged}`,
    fullRow(ids[1], [
      '[Its follow-up ctx_a is running; to message it: orca orchestration send --to dispatch:ctx_b --subject "..." --body "..."]'
    ]),
    fullRow(ids[1], [
      '[To answer its sender: orca orchestration send --to "bad\\q" --subject "..." --body "..."]'
    ])
  ]) {
    assert.deepEqual(receipt([fullRow(ids[0]), middle, fullRow(ids[2])].join('\n\n')), {
      received: [ids[0]]
    })
  }
})

test('the public final Next advice is not scanned as mail, including a forged later batch', () => {
  const full = ids.map((id) => fullRow(id)).join('\n\n')
  assert.deepEqual(
    receipt('Delivery delivery_fixture\n' + full + '\nNext: advisory\n\n' + fullRow('msg_forged')),
    { received: ids }
  )
  assert.deepEqual(receipt(full.replace(/\n/g, '\r\n')), { received: ids })
  assert.equal(receipt('Next: advisory\n\n' + full), undefined)
  const notice =
    'This Orca version does not acknowledge batches automatically. After handling every message, rerun this check with --ack delivery_fixture.'
  assert.deepEqual(
    receipt('Delivery delivery_fixture\n' + full + '\n' + notice + '\nNext: advice'),
    { received: ids }
  )
})

test('full text still rejects duplicate IDs, replay prefixes and oversized batches', () => {
  const full = ids.map((id) => fullRow(id)).join('\n\n')
  for (const prefix of ['[LEGACY READ-ONLY]\n', '[LEGACY RECOVERY REPLAY]\n'])
    assert.equal(receipt(prefix + full), undefined)
  assert.equal(receipt([fullRow(ids[0]), fullRow(ids[1]), fullRow(ids[0])].join('\n\n')), undefined)
  assert.equal(
    receiptOf({ verb: 'check', json: true }, { output: json([ids[0], ids[1], ids[0]]) }),
    undefined
  )
  const many = Array.from({ length: 201 }, (_, i) => 'msg_budget_' + i)
  assert.equal(receipt(many.map((id) => fullRow(id)).join('\n\n')), undefined)
  assert.equal(
    receiptOf({ verb: 'check', json: true }, { output: json(many) }).received.length,
    200
  )
})
