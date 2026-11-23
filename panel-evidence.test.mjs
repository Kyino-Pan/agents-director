import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './worker/activity-store.mjs'
import { pageFor } from './panel-test-browser.mjs'

test('window evidence distinguishes completion from renewed Done samples, including edge events', async () => {
  const now = Date.UTC(2026, 8, 1, 12)
  const start = now - 300000
  const store = new ActivityStore(start - 900000)
  let seq = 0
  const point = (agent, offset, state, until) =>
    store.point(String(++seq), agent, start + offset, state, 'live', start + until)
  point('repeated', -30000, 'done', -1)
  point('repeated', 0, 'done', 30000)
  point('repeated', 50000, 'done', 300000)
  point('first-done', 10000, 'done', 300000)
  point('history-first', -60000, 'unknown', -100)
  point('history-first', 1000, 'done', 300000)
  point('expired', -60000, 'working', -30001)
  point('expired', -30000, 'done', 20000)
  point('expired', 32000, 'done', 300000)
  point('only-gap', 0, 'unknown', 300000)
  point('left-boundary', -30000, 'blocked', 0)
  point('left-boundary', 0, 'done', 300000)
  point('right-boundary', -30000, 'waiting', 0)
  point('right-boundary', 300000, 'done', 300000)
  point('offline-crosses-window', -800000, 'working', -60000)
  point('offline-crosses-window', 50000, 'done', 300000)
  point('instant-work', 20000, 'working', 20000)
  for (const state of ['working', 'waiting', 'blocked']) point(state, 50000, state, 60000)
  for (const id of ['sender', 'receiver', 'inbox', 'limited']) point(id, -40000, 'done', 300000)
  store.agent('parent')
  store.agent('child', { parentId: 'parent', spawnedAt: start + 1000 })
  store.message({
    id: 'direct',
    from: 'sender',
    to: 'receiver',
    at: start + 2000,
    type: 'Send accepted'
  })
  store.message({ id: 'mail', from: null, to: 'inbox', at: now, type: 'Mailbox input' })
  const raw = store.serialize()
  const restored = new ActivityStore(now)
  restored.restore(structuredClone(raw), now)
  const data = restored.snapshot(now, { hideShortTasks: true })
  assert.deepEqual(restored.serialize(), raw)
  assert.equal(data.hiddenShortTasks, 0)
  const limited = data.agents.find((a) => a.id === 'limited')
  limited.omittedRanges = [{ start: start + 90000, end: start + 96000 }]
  limited.omittedActivity = [start + 90000, start + 96000]
  limited.omittedSegments = 1
  limited.segments = []
  const { page, errors } = await pageFor({
    data,
    preferences: new Map([['view:window-hours', 1 / 12]])
  })
  try {
    await page.locator('.lane').first().waitFor()
    const ids = await page
      .locator('.lane')
      .evaluateAll((rows) => rows.map((row) => row.dataset.agent).sort())
    assert.deepEqual(
      ids,
      [
        'instant-work',
        'working',
        'waiting',
        'blocked',
        'parent',
        'child',
        'sender',
        'receiver',
        'inbox',
        'limited'
      ].sort()
    )
    assert.equal(await page.locator('.spawn').count(), 1)
    assert.equal(await page.locator('.message-path').count(), 1)
    assert.equal(await page.locator('.mailbox-input').count(), 1)
    assert.equal(
      await page.locator('.lane[data-agent="limited"] .lane-state').textContent(),
      'History limited'
    )
    await page.locator('.lane[data-agent="instant-work"]').click()
    assert.match(await page.locator('#detail-body').innerText(), /Observed Working at/)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('an adjacent window cannot borrow work from either side of a Done or Unobserved interval', async () => {
  const { page } = await pageFor()
  try {
    const result = await page.evaluate(async () => {
      const { windowActivity, activeAgents } = await import('./panel-identity.mjs')
      const { terminalKey } = await import('./pin-identity.mjs')
      const lane = {
        id: 'quiet',
        segments: [
          { state: 'working', start: 0, end: 10 },
          { state: 'done', start: 10, end: 18, completionSince: 10 },
          { state: 'unknown', start: 18, end: 20, joinedWork: true },
          { state: 'blocked', start: 20, end: 30 }
        ],
        stateEvents: [{ state: 'done', at: 10, completionSince: 10 }]
      }
      const view = { agents: [lane], messages: [] }
      const activity = (start, end) => windowActivity(view, start, end).has(lane.id)
      return {
        spans: [
          [0, 10],
          [10, 18],
          [18, 20],
          [10, 20],
          [20, 30]
        ].map(([start, end]) => activity(start, end)),
        defaultCount: activeAgents(view, 10, 20).length,
        pinnedCount: activeAgents(view, 10, 20, new Set([terminalKey(lane)])).length
      }
    })
    assert.deepEqual(result, {
      spans: [true, false, false, false, true],
      defaultCount: 0,
      pinnedCount: 1
    })
  } finally {
    await page.close()
  }
})

test('budget clipping keeps the precise active subintervals and instants inside a larger omission', async () => {
  const base = Date.UTC(2026, 8, 1, 12)
  const end = base + 360000
  const store = new ActivityStore(base)
  for (let lane = 0; lane < 150; lane++) {
    for (let sample = 0; sample < 18; sample++) {
      const at = base + sample * 20000
      const states = ['working', 'blocked', 'waiting']
      const state = lane === 1 && sample < 3 ? states[sample] : 'done'
      store.point(
        lane + '-' + sample,
        String(lane),
        at,
        state,
        'live',
        at + (state === 'blocked' ? 0 : 2000)
      )
    }
  }
  const data = store.snapshot(end)
  const positive = data.agents.find((a) => a.id === '1')
  assert.equal(
    data.agents.reduce((sum, a) => sum + a.segments.length, 0),
    4000
  )
  assert.deepEqual(positive.omittedActivity, [base, base + 2000, base + 40000, base + 42000])
  assert.ok(positive.omittedRanges.some((r) => r.start === base && r.end > base + 42000))
  assert.deepEqual(positive.stateEvents, [{ at: base + 20000, state: 'blocked' }])
  assert.equal(data.agents.filter((a) => a.omittedActivity).length, 1)
  const { page } = await pageFor({ data })
  try {
    const counts = await page.evaluate(
      async ({ data, base }) => {
        const { windowActivity } = await import('./panel-identity.mjs')
        return [
          [0, 2000],
          [2000, 19999],
          [2000, 20000],
          [20000, 39999],
          [20001, 40000],
          [40000, 42000],
          [42000, 48000]
        ].map(([start, end]) => [...windowActivity(data, base + start, base + end)])
      },
      { data, base }
    )
    assert.deepEqual(counts, [['1'], [], ['1'], ['1'], [], ['1'], []])
    await page.locator('.lane[data-agent="1"]').click()
    assert.match(
      await page.locator('#detail-body').innerText(),
      /Recorded activity in this window was omitted/
    )
  } finally {
    await page.close()
  }
})
