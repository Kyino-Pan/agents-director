import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageFor } from './panel-test-browser.mjs'
import { providerFlow } from './worker/provider-tool-receipts.fixture.mjs'

test('contract-shaped Devin and Claude terminal flows reach visible solid and dashed SVG paths', async () => {
  for (const [source, target] of [
    ['devin', 'claude'],
    ['claude', 'devin']
  ]) {
    const f = await providerFlow(source, target)
    for (let poll = 0; poll < 24; poll++) {
      f.advance(5000)
      await f.scan()
    }
    const snapshot = f.snapshot()
    const parent = snapshot.agents.find((agent) => agent.sessionId === 'parent')
    const child = snapshot.agents.find((agent) => agent.sessionId === 'child')
    const { page, errors } = await pageFor({
      preferences: new Map([
        ['view:window-hours', 1 / 12],
        ['view:hide-short-tasks', false]
      ]),
      getSnapshot: (input) => f.store.snapshot(f.now, input)
    })
    try {
      await page.waitForFunction(() => document.querySelectorAll('.spawn').length === 1)
      assert.equal(await page.locator('.lane').count(), 2)
      assert.equal(await page.locator('.message-path').count(), 1)
      assert.equal(await page.locator('.mailbox-input').count(), 0)
      assert.deepEqual(
        await page.locator('.spawn').evaluate((el) => ({
          from: el.dataset.from,
          to: el.dataset.to,
          dash: getComputedStyle(el).strokeDasharray,
          marker: el.getAttribute('marker-end')
        })),
        {
          from: parent.id,
          to: child.id,
          dash: 'none',
          marker: 'url(#spawn-arrow)'
        }
      )
      assert.notEqual(
        await page.locator('.spawn').evaluate((el) => getComputedStyle(el).stroke),
        'none'
      )
      assert.deepEqual(
        await page
          .locator('.message-target')
          .evaluate((el) => [el.dataset.from, el.dataset.to, el.dataset.status]),
        [parent.id, child.id, 'Mailbox received']
      )
      assert.deepEqual(
        await page.locator('.message-path').evaluate((el) => ({
          dash: getComputedStyle(el).strokeDasharray,
          marker: el.getAttribute('marker-end')
        })),
        { dash: '4px, 3px', marker: 'url(#message-arrow)' }
      )
      assert.ok((await page.locator('.segment').count()) >= 2)
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  }
})
