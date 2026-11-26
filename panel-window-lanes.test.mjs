import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageFor } from './panel-test-browser.mjs'
import { ActivityStore } from './worker/activity-store.mjs'

const NOW = Date.parse('2026-11-26T10:00:00Z')

test('crowded window snapshots draw current activity and reselect it when paused, panned and widened', async () => {
  const store = new ActivityStore(NOW - 6 * 3600000)
  for (let i = 0; i < 200; i++) {
    const id = 'a-summary-' + i
    store.agent(id, { label: id, provider: 'codex', sessionId: id })
    store.point(id, id, NOW - 6 * 3600000, 'unknown', 'history', NOW)
  }
  for (const [id, at, until] of [
    ['z-earlier', NOW - 3 * 3600000, NOW - 2 * 3600000],
    ['z-current', NOW - 600000, NOW]
  ]) {
    store.agent(id, { label: id, provider: 'codex', sessionId: id })
    store.point(id, id, at, 'working', 'live', until)
  }
  const raw = store.serialize()
  let clock = NOW
  const { page, errors } = await pageFor({
    preferences: new Map([
      ['view:window-hours', 1],
      ['view:hide-short-tasks', false]
    ]),
    getSnapshot: (input) => store.snapshot(clock, input)
  })
  const lanes = () =>
    page.locator('.lane').evaluateAll((rows) => rows.map((row) => row.dataset.agent))
  const range = async (start, end) => {
    const local = (at) => new Date(at + 8 * 3600000).toISOString().slice(0, -1)
    await page.evaluate(
      ({ start, end }) => {
        document.querySelector('#range-start').value = start
        document.querySelector('#range-end').value = end
        document.querySelector('#range-end').dispatchEvent(new Event('change'))
      },
      { start: local(start), end: local(end) }
    )
  }
  try {
    await page.locator('.lane[data-agent="z-current"]').waitFor()
    assert.deepEqual(await lanes(), ['z-current'])
    assert.equal(await page.locator('.segment.working').count(), 1)
    await page.locator('#pause').click()
    await range(NOW - 3 * 3600000, NOW - 2 * 3600000)
    await page.locator('.lane[data-agent="z-earlier"]').waitFor()
    assert.deepEqual(await lanes(), ['z-earlier'])
    clock += 600000
    await page.evaluate(() => window.notifyActivity())
    assert.deepEqual(await lanes(), ['z-earlier'])
    await range(NOW - 6 * 3600000, NOW)
    await page.waitForFunction(() => document.querySelectorAll('.lane').length === 2)
    assert.deepEqual((await lanes()).sort(), ['z-current', 'z-earlier'])
    assert.equal(await page.locator('.segment.working').count(), 2)
    assert.equal(await page.locator('#pause').getAttribute('aria-pressed'), 'true')
    assert.deepEqual(errors, [])
    assert.deepEqual(store.serialize(), raw)
  } finally {
    await page.close()
  }
})
