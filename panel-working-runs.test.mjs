import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ActivityStore } from './worker/activity-store.mjs'
import { frozenWorkingRuns } from './worker/working-runs.fixture.mjs'
import { pageFor } from './panel-test-browser.mjs'

async function range(page, start, end) {
  await page.evaluate(
    ({ start, end }) => {
      const local = (at) =>
        new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      document.querySelector('#range-start').value = local(start)
      document.querySelector('#range-end').value = local(end)
      document.querySelector('#range-end').dispatchEvent(new Event('change', { bubbles: true }))
    },
    { start, end }
  )
  await page.waitForFunction(
    ({ start, end }) => {
      const requests = window.snapshotRequests
      const view = requests.at(-1)?.view
      return view?.end === end && view.hours * 3600000 === end - start
    },
    { start, end }
  )
}

for (const width of [320, 1100]) {
  test(`the strict 30-second record boundary has one or two Working targets at ${width}px`, async () => {
    const at = Date.parse('2026-11-27T06:00:00Z')
    const now = at + 120000
    const store = new ActivityStore(at - 3600000)
    for (const gap of [29999, 30000, 30001]) {
      const id = 'threshold-' + gap
      store.agent(id, { sessionId: id, provider: 'claude', label: id, projectId: 'p' })
      store.point(id + '-left', id, at, 'working', 'live', at + 30000)
      store.point(id + '-middle', id, at + 30000, 'done', 'live', at + 30000 + gap)
      store.point(id + '-right', id, at + 30000 + gap, 'working', 'live', at + 60000 + gap)
      store.point(id + '-tail', id, at + 60000 + gap, 'done', 'live', now)
    }
    const { page, errors } = await pageFor({
      width,
      height: 920,
      dark: true,
      preferences: new Map([
        ['view:window-hours', 1 / 12],
        ['view:hide-short-tasks', false]
      ]),
      getSnapshot: (input) => store.snapshot(now, input)
    })
    try {
      for (const gap of [29999, 30000, 30001]) {
        const work = page
          .locator(`.segment-target[data-agent="threshold-${gap}"]`)
          .filter({ has: page.locator('.segment.working') })
        assert.equal(await work.count(), gap < 30000 ? 1 : 2)
        if (gap < 30000) {
          await work.focus()
          await page.keyboard.press('Enter')
          assert.match(await page.locator('#detail-meta').textContent(), /1 min 29\.999 s/)
        }
      }
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  })
  for (const sample of frozenWorkingRuns) {
    test(`${sample.name} selects one complete record across pause, pan, zoom and ${width}px layout`, async () => {
      const store = new ActivityStore(sample.points[0][0] - 3600000)
      store.agent('claude', {
        sessionId: sample.name,
        provider: 'claude',
        label: sample.name,
        projectId: 'project'
      })
      for (const [i, [at, until, state]] of sample.points.entries())
        store.point(String(i), 'claude', at, state, 'live', until)
      const now = sample.points.at(-1)[1]
      const { page, errors } = await pageFor({
        width,
        height: 920,
        dark: true,
        preferences: new Map([
          ['view:window-hours', 1],
          ['view:hide-short-tasks', false]
        ]),
        getSnapshot: (input) => store.snapshot(now, input)
      })
      try {
        const target = page.locator('.segment-target')
        assert.equal(await target.count(), 1)
        assert.equal(await target.locator('.segment.working').count(), 1)
        await target.hover()
        assert.match(
          await target.locator('.segment').evaluate((el) => getComputedStyle(el).filter),
          /brightness/
        )
        await target.focus()
        await page.keyboard.press('Enter')
        assert.match(await page.locator('#detail-heading').textContent(), /Working/)
        const detail = await page.locator('#detail-meta').textContent()
        const label = await target.getAttribute('aria-label')
        const key = await target.getAttribute('data-key')
        assert.equal(await page.locator('.segment-target[data-selected="true"]').count(), 1)
        await page.locator('#pause').click()
        const end = Math.floor(now / 60000) * 60000
        const start = end - 300000
        await range(page, start, end)
        await page.waitForFunction(
          (key) => document.querySelector('.segment-target')?.dataset.key === key,
          key
        )
        assert.equal(await page.locator('#detail-meta').textContent(), detail)
        assert.equal(await target.getAttribute('aria-label'), label)
        assert.equal(await page.locator('.segment-target[data-selected="true"]').count(), 1)
        await page.locator('#chart-scroll').dispatchEvent('wheel', { deltaX: 20, deltaY: 0 })
        await page.waitForFunction(
          (end) => window.snapshotRequests.at(-1)?.view.end === end + 10000,
          end
        )
        assert.equal(await page.locator('#detail-meta').textContent(), detail)
        await page.getByRole('slider', { name: 'Window' }).fill('500')
        await page.waitForFunction(() => window.snapshotRequests.at(-1)?.view.hours > 1 / 12)
        assert.equal(await page.locator('#detail-meta').textContent(), detail)
        assert.equal(await target.getAttribute('data-key'), key)
        await page.setViewportSize({ width: width === 320 ? 1100 : 320, height: 920 })
        assert.equal(await target.count(), 1)
        assert.equal(await page.locator('#detail-meta').textContent(), detail)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        if (process.env.ACTIVITY_SCREENSHOTS) {
          await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
          await page.screenshot({
            path: join(process.env.ACTIVITY_SCREENSHOTS, `run-${sample.gap}-${width}.png`)
          })
        }
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    })
  }

  test(`a pending gap becomes the same whole selection when right Working arrives at ${width}px`, async () => {
    const at = Date.parse('2026-11-27T06:00:00Z')
    const store = new ActivityStore(at - 3600000)
    store.agent('live', {
      sessionId: 'live',
      provider: 'claude',
      label: 'Live Claude',
      projectId: 'p'
    })
    store.point('left', 'live', at, 'working', 'live', at + 60000)
    store.point('pending', 'live', at + 61659, 'done', 'live', at + 61659)
    let now = at + 61659
    const { page, errors } = await pageFor({
      width,
      height: 920,
      dark: true,
      preferences: new Map([
        ['view:window-hours', 1 / 12],
        ['view:hide-short-tasks', false]
      ]),
      getSnapshot: (input) => store.snapshot(now, input)
    })
    try {
      const pending = page
        .locator('.segment-target')
        .filter({ has: page.locator('.segment.unknown') })
      await pending.focus()
      await page.keyboard.press('Enter')
      assert.match(await page.locator('#detail-heading').textContent(), /Unobserved/)
      now = at + 70000
      store.point('right', 'live', at + 64897, 'working', 'live', now)
      await page.evaluate(() => window.notifyActivity())
      await page.waitForFunction(() =>
        /Working/.test(document.querySelector('#detail-heading').textContent)
      )
      assert.equal(await page.locator('.segment-target').count(), 1)
      assert.equal(await page.locator('.segment-target[data-selected="true"]').count(), 1)
      assert.match(await page.locator('#detail-meta').textContent(), /1 min 10 s|70 s|1m 10s/)
      now = at + 71000
      store.point('pending-again', 'live', now, 'done', 'live', now)
      await page.evaluate(() => window.notifyActivity())
      const gap = page.locator('.segment-target').filter({ has: page.locator('.segment.unknown') })
      await gap.waitFor()
      await gap.focus()
      now = at + 80000
      store.point('right-again', 'live', at + 74000, 'working', 'live', now)
      await page.evaluate(() => window.notifyActivity())
      await page.waitForFunction(
        () =>
          document.activeElement?.matches('.segment-target') &&
          document.querySelectorAll('.segment-target').length === 1
      )
      await page.keyboard.press('Enter')
      assert.match(await page.locator('#detail-meta').textContent(), /1 min 20 s/)
      const detail = await page.locator('#detail-meta').textContent()
      await page.locator('#pause').click()
      now += 5000
      store.point('final', 'live', now, 'done', 'live', now)
      await page.evaluate(() => window.notifyActivity())
      assert.equal(await page.locator('#detail-meta').textContent(), detail)
      await page.locator('#pause').click()
      await page.waitForFunction(() =>
        document.querySelector('.lane-state')?.textContent.includes('Done')
      )
      assert.equal(await page.locator('#detail-meta').textContent(), detail)
      assert.equal(store.serialize().points.filter((p) => p.state === 'done').length, 1)
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  })
}
