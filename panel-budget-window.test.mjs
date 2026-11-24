import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './worker/activity-store.mjs'
import { pageFor } from './panel-test-browser.mjs'

const NOW = Date.parse('2026-11-24T08:00:00Z')
const local = (at) => new Date(at + 8 * 3600000).toISOString().slice(0, 19)
const minute = (at) => local(at).slice(0, 16)
async function range(page, start, end) {
  await page.evaluate(
    ({ start, end }) => {
      document.querySelector('#range-start').value = start
      document.querySelector('#range-end').value = end
      document.querySelector('#range-end').dispatchEvent(new Event('change'))
    },
    { start: local(start), end: local(end) }
  )
}
function fixture() {
  const store = new ActivityStore(NOW - 3600000)
  store.agent('a', { label: 'A session', provider: 'codex', sessionId: 'a' })
  let clock = NOW
  const inputs = []
  let sequence = 0
  let hold
  const getSnapshot = async (input) => {
    inputs.push(structuredClone(input))
    store.point('work', 'a', NOW - 3600000, 'working', 'live', clock)
    const result = store.snapshot(clock, input)
    result.agents[0].label = 'sample-' + ++sequence
    if (hold) {
      const callback = hold
      hold = null
      await callback(result)
    }
    return result
  }
  return { store, inputs, getSnapshot, tick: () => (clock += 60000), hold: (f) => (hold = f) }
}

test('first load, live clock, paused refresh, pan, zoom and resume request their own viewport', async () => {
  const f = fixture()
  const { page, errors } = await pageFor({
    getSnapshot: f.getSnapshot,
    preferences: new Map([['view:window-hours', 1 / 12]])
  })
  try {
    await page.locator('.lane').waitFor()
    assert.deepEqual(f.inputs[0].view, { hours: 1 / 12, end: null })
    const liveEnd = f.tick()
    await page.evaluate(() => window.notifyActivity())
    await page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(liveEnd)
    )
    await page.locator('#pause').click()
    await page.waitForFunction(
      () => document.querySelector('#pause').getAttribute('aria-pressed') === 'true'
    )
    assert.equal(f.inputs.at(-1).view.end, liveEnd)
    const pausedLabel = await page.locator('.lane-name').textContent()
    const length = f.inputs.length
    f.tick()
    await page.evaluate(() => window.notifyActivity())
    await page.waitForFunction((n) => window.snapshotRequests.length > n, length)
    assert.equal(await page.locator('#range-end').inputValue(), minute(liveEnd))
    assert.equal(await page.locator('.lane-name').textContent(), pausedLabel)
    const panEnd = NOW - 600000
    await range(page, panEnd - 300000, panEnd)
    await page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(panEnd)
    )
    assert.deepEqual(f.inputs.at(-1).view, { hours: 1 / 12, end: panEnd })
    await page.locator('.zoom-tick[data-hours="0.25"]').click()
    await page.waitForFunction(() => document.querySelector('#range-start').value.endsWith('15:35'))
    assert.deepEqual(f.inputs.at(-1).view, { hours: 0.25, end: panEnd })
    await page.locator('#pause').click()
    assert.equal(f.inputs.at(-1).view.end, panEnd)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('an older viewport reply or failure cannot replace the newer requested plot', async () => {
  for (const fail of [false, true]) {
    const f = fixture()
    const { page, errors } = await pageFor({ getSnapshot: f.getSnapshot })
    try {
      await page.locator('.lane').waitFor()
      await page.evaluate(() => {
        window.seenLabels = []
        new MutationObserver(() =>
          window.seenLabels.push(document.querySelector('.lane-name')?.textContent)
        ).observe(document.querySelector('#lanes'), { childList: true, subtree: true })
      })
      let release
      let entered
      const started = new Promise((r) => (entered = r))
      f.hold(async (result) => {
        result.agents[0].label = 'obsolete-window'
        entered()
        await new Promise((r) => (release = r))
        if (fail) throw new Error('Obsolete viewport failed')
      })
      const oldEnd = NOW - 600000,
        newEnd = NOW - 1200000
      await range(page, oldEnd - 300000, oldEnd)
      await started
      await range(page, newEnd - 300000, newEnd)
      release()
      await page.waitForFunction(
        (end) => document.querySelector('#range-end').value === end,
        minute(newEnd)
      )
      assert.equal(f.inputs.at(-1).view.end, newEnd)
      assert.equal(await page.evaluate(() => window.seenLabels.includes('obsolete-window')), false)
      assert.equal(await page.locator('#failure').isHidden(), true)
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  }
})

test('two frames can inspect different windows without changing the shared recorder or each other', async () => {
  const f = fixture()
  const preferences = new Map([['view:window-hours', 1 / 12]])
  const first = await pageFor({ getSnapshot: f.getSnapshot, preferences })
  const second = await pageFor({ getSnapshot: f.getSnapshot, preferences })
  try {
    await first.page.locator('.lane').waitFor()
    await second.page.locator('.lane').waitFor()
    const before = f.store.serialize()
    const end1 = NOW - 600000,
      end2 = NOW - 1800000
    await range(first.page, end1 - 300000, end1)
    await range(second.page, end2 - 600000, end2)
    await first.page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(end1)
    )
    await second.page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(end2)
    )
    assert.equal(await first.page.locator('#range-end').inputValue(), minute(end1))
    assert.deepEqual(f.store.serialize(), before)
    assert.deepEqual(first.errors, [])
    assert.deepEqual(second.errors, [])
  } finally {
    await first.page.close()
    await second.page.close()
  }
})

test('a viewport change during an omission follow-up discards the entire older response', async () => {
  const f = fixture()
  const { page, errors } = await pageFor({
    getSnapshot: async (input) => {
      const data = await f.getSnapshot(input)
      // Force a real paired follow-up, as an over-budget viewport would require.
      data.agents[0].omittedActivity = [NOW - 1000, NOW]
      data.agents[0].omittedRanges = [{ start: NOW - 1000, end: NOW }]
      data.agents[0].omittedSegments = 1
      if (input.view.end === NOW - 600000) data.agents[0].label = 'obsolete-omissions'
      return data
    }
  })
  try {
    await page.locator('.lane').waitFor()
    await page.evaluate(() => {
      const request = window.orca.plugin.request
      window.omissionHeld = false
      window.orca.plugin.request = async (name, input) => {
        if (name === 'activity.omittedActivity' && !window.omissionHeld) {
          window.omissionHeld = true
          await new Promise((resolve) => (window.releaseOmission = resolve))
        }
        return request(name, input)
      }
      window.seenLabels = []
      new MutationObserver(() =>
        window.seenLabels.push(document.querySelector('.lane-name')?.textContent)
      ).observe(document.querySelector('#lanes'), { childList: true, subtree: true })
    })
    await range(page, NOW - 900000, NOW - 600000)
    await page.waitForFunction(() => window.omissionHeld)
    await range(page, NOW - 1500000, NOW - 1200000)
    await page.evaluate(() => window.releaseOmission())
    await page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(NOW - 1200000)
    )
    assert.equal(await page.evaluate(() => window.seenLabels.includes('obsolete-omissions')), false)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('a trackpad burst coalesces viewport requests and delivers its final bounds', async () => {
  const f = fixture()
  const { page, errors } = await pageFor({
    getSnapshot: f.getSnapshot,
    preferences: new Map([['view:window-hours', 1 / 12]])
  })
  try {
    await page.locator('.lane').waitFor()
    await page.locator('#chart-scroll').evaluate((chart) => {
      for (let i = 0; i < 120; i++)
        chart.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: -1,
            shiftKey: true,
            cancelable: true
          })
        )
    })
    await page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(NOW - 60000)
    )
    assert.equal(f.inputs.at(-1).view.end, NOW - 60000)
    assert.ok(f.inputs.length <= 2)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('pin updates during pause do not advance the anchor used by subsequent panning', async () => {
  const f = fixture()
  const { page, errors } = await pageFor({
    getSnapshot: f.getSnapshot,
    preferences: new Map([['view:window-hours', 1 / 12]])
  })
  try {
    await page.locator('.lane').waitFor()
    await page.locator('#pause').click()
    f.tick()
    await page.locator('.lane-row .pin-control').click()
    await page.locator('.lane-row .pin-control[aria-pressed="true"]').waitFor()
    await page.locator('#chart-scroll').evaluate((chart) =>
      chart.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: -1,
          shiftKey: true,
          cancelable: true
        })
      )
    )
    await page.waitForFunction(
      (end) => document.querySelector('#range-end').value === end,
      minute(NOW - 500)
    )
    assert.equal(f.inputs.at(-1).view.end, NOW - 500)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
