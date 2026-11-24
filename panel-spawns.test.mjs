import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityStore } from './worker/activity-store.mjs'
import { pageFor } from './panel-test-browser.mjs'

test('a crowded narrow view retains both spawn endpoints without other activity and pans the real event in and out', async () => {
  const now = Date.parse('2026-11-24T08:00:00Z')
  const store = new ActivityStore(now - 3600000)
  for (let index = 0; index < 160; index++) {
    const id = 'a-' + String(index).padStart(3, '0')
    store.agent(id, { label: id, sessionId: id, projectId: 'p' })
    store.point(id, id, now - 3600000, 'working', 'live', now)
  }
  for (const id of ['z-parent', 'z-child']) {
    store.agent(id, { label: 'Same name', sessionId: id, projectId: 'p' })
    store.point(id, id, now - 3600000, 'unknown', 'history', now - 3500000)
  }
  store.agent('z-child', { parentId: 'z-parent', spawnedAt: now - 600000 })
  const { page, errors } = await pageFor({
    width: 390,
    preferences: new Map([['view:window-hours', 1 / 12]]),
    getSnapshot: (input) => store.snapshot(now, input)
  })
  const inspectSpawn = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.spawn').length === 1)
    assert.equal(await page.locator('.lane').count(), 160)
    assert.deepEqual(
      await page.evaluate(() => {
        const el = document.querySelector('.spawn')
        return {
          from: el.dataset.from,
          to: el.dataset.to,
          dash: getComputedStyle(el).strokeDasharray,
          marker: el.getAttribute('marker-end')
        }
      }),
      { from: 'z-parent', to: 'z-child', dash: 'none', marker: 'url(#spawn-arrow)' }
    )
  }
  const range = () =>
    page.evaluate(
      ({ start, end }) => {
        document.querySelector('#range-start').value = start
        document.querySelector('#range-end').value = end
        document.querySelector('#range-end').dispatchEvent(new Event('change'))
      },
      {
        start: new Date(now - 800000 + 8 * 3600000).toISOString().slice(0, 19),
        end: new Date(now - 500000 + 8 * 3600000).toISOString().slice(0, 19)
      }
    )
  try {
    assert.equal(await page.locator('.spawn').count(), 0)
    await range()
    await inspectSpawn()
    await page.locator('#chart-scroll').dispatchEvent('wheel', { deltaX: 1800, cancelable: true })
    await page.waitForFunction(() => !document.querySelector('.spawn'))
    await range()
    await inspectSpawn()
    assert.equal(store.agents.get('z-child').spawnedAt, now - 600000)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
