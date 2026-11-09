import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ActivityStore } from './worker/activity-store.mjs'
import { pageFor } from './panel-test-browser.mjs'

const NOW = Date.parse('2026-11-02T08:00:00Z')
function fixture() {
  const store = new ActivityStore(NOW - 3600000)
  for (const [id, duration] of [
    ['short', 1000],
    ['long', 180000]
  ]) {
    store.agent(id, { label: `${id} task`, projectId: 'p', projectName: 'Project' })
    const end = NOW - (id === 'long' ? 240_000 : 1000)
    store.point(`${id}-start`, id, end - duration, 'working', 'journal', end)
    store.point(`${id}-end`, id, end, 'done', 'journal')
  }
  store.agent('long', { parentId: 'short', spawnedAt: NOW - 420000 })
  store.message({ id: 'filtered-message', from: 'short', to: 'long', at: NOW - 1000 })
  return store
}

for (const [width, dark] of [
  [1100, false],
  [320, true]
]) {
  test(`short-task preference requests fresh data and reappears after reopen at ${width}px`, async () => {
    const store = fixture()
    const preferences = new Map()
    const options = { width, dark, preferences, getSnapshot: (input) => store.snapshot(NOW, input) }
    const first = await pageFor(options)
    const { page, errors } = first
    try {
      const toggle = page.getByRole('button', { name: 'Hide short tasks (< 3 min)', exact: true })
      await page.getByText('long task', { exact: true }).waitFor()
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('.lane').count(), 1)
      assert.equal(await page.locator('.spawn, .message-path').count(), 0)
      await page.locator('.lane').click()
      assert.match(
        await page.locator('#detail-body').textContent(),
        /short \(outside this snapshot\)/
      )
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Shorter links' }).click()
      await page.getByRole('slider', { name: 'Window' }).focus()
      await page.keyboard.press('Home')
      await page.getByRole('searchbox').fill('task')
      const period = await page.locator('#period').textContent()
      await page.getByRole('button', { name: 'Pause view' }).click()
      await toggle.focus()
      await page.keyboard.press('Space')
      await page.getByText('short task', { exact: true }).waitFor()
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
      assert.equal(await page.locator('.lane').count(), 2)
      // The long task has only one minute of execution in this five-minute view;
      // its full three-minute observation keeps it eligible, and its older spawn stays out.
      assert.equal(await page.locator('.spawn').count(), 0)
      assert.equal(await page.locator('.message-path').count(), 1)
      assert.equal(await page.locator('#shorten-links').getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('#pause').getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('#period').textContent(), period)
      assert.equal(await page.getByRole('searchbox').inputValue(), 'task')
      await page.waitForFunction(
        async () =>
          (await window.orca.storage.get('view:hide-short-tasks')) === false &&
          (await window.orca.storage.get('view:window-hours')) === 1 / 12
      )
      assert.deepEqual(
        await page.evaluate(() => window.snapshotRequests.map((input) => input.hideShortTasks)),
        [true, false]
      )
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      if (process.env.ACTIVITY_SCREENSHOTS) {
        await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
        await page.screenshot({
          path: join(process.env.ACTIVITY_SCREENSHOTS, `short-tasks-${width}.png`)
        })
      }
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
    const reopened = await pageFor(options)
    try {
      await reopened.page.getByText('short task', { exact: true }).waitFor()
      assert.equal(
        await reopened.page.locator('#hide-short-tasks').getAttribute('aria-pressed'),
        'false'
      )
      assert.equal(
        await reopened.page.locator('#shorten-links').getAttribute('aria-pressed'),
        'true'
      )
      assert.equal(await reopened.page.locator('#zoom-value').textContent(), '5m')
      await reopened.page.locator('#hide-short-tasks').click()
      await reopened.page.waitForFunction(() => document.querySelectorAll('.lane').length === 1)
      assert.deepEqual(reopened.errors, [])
    } finally {
      await reopened.page.close()
    }
  })
}

test('all-hidden empty state keeps the filter reachable and switching off restores activity', async () => {
  const store = fixture()
  store.agents.delete('long')
  for (const [id, point] of store.points) {
    if (point.agentId === 'long') store.points.delete(id)
  }
  store.messages.clear()
  const { page, errors } = await pageFor({
    width: 320,
    height: 700,
    dark: false,
    getSnapshot: (input) => store.snapshot(NOW, input)
  })
  try {
    await page.getByText('Short tasks are hidden', { exact: true }).waitFor()
    assert.match(await page.locator('#empty').textContent(), /Turn off Hide short tasks/)
    const toggle = page.locator('#hide-short-tasks')
    assert.equal(await toggle.isVisible(), true)
    if (process.env.ACTIVITY_SCREENSHOTS) {
      await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
      await page.screenshot({
        path: join(process.env.ACTIVITY_SCREENSHOTS, 'short-tasks-empty-320.png')
      })
    }
    await toggle.click()
    await page.getByText('short task', { exact: true }).waitFor()
    assert.equal(await page.locator('#empty').isHidden(), true)
    await toggle.click()
    await page.getByText('Short tasks are hidden', { exact: true }).waitFor()
    assert.equal(await page.locator('.lane, .segment-target, .message-target, .spawn').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
