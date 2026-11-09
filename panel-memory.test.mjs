import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageFor } from './panel-test-browser.mjs'
import { snapshot } from './panel.fixture.mjs'

test('memory fits the existing narrow agent column, explains scope and omits missing values', async () => {
  const data = structuredClone(snapshot)
  data.agents[0].memory = { bytes: 1.25 * 1024 ** 3, metric: 'footprint', collectedAt: Date.now() }
  data.agents[1].memory = { bytes: 128 * 1024 ** 2, metric: 'rss', collectedAt: Date.now() }
  data.agents[2].memory = { bytes: -1, metric: 'rss', collectedAt: Date.now() }
  for (const dark of [false, true]) {
    const { page, errors } = await pageFor({ width: 360, height: 640, dark, data })
    try {
      assert.equal(await page.locator('.lane-memory').count(), 2)
      const badge = page.locator(`.lane[data-agent="${data.agents[0].id}"] .lane-memory`)
      assert.equal(await badge.textContent(), '1.3 GiB')
      assert.match(
        await badge.getAttribute('title'),
        /Live terminal and child processes.*footprint/
      )
      assert.deepEqual(
        await page.locator('.lane-memory').evaluateAll((badges) =>
          badges.map((b) => {
            const lane = b.closest('.lane').getBoundingClientRect()
            const rect = b.getBoundingClientRect()
            const name = b.parentElement.querySelector('.lane-name').getBoundingClientRect()
            return {
              fits: rect.right <= lane.right && rect.left >= name.right,
              nameVisible: name.width >= 20,
              narrow: lane.width <= 128
            }
          })
        ),
        [
          { fits: true, nameVisible: true, narrow: true },
          { fits: true, nameVisible: true, narrow: true }
        ]
      )
      await page.screenshot({ path: `/tmp/agents-director-memory-${dark ? 'dark' : 'light'}.png` })
      await page.evaluate(() => {
        for (const agent of window.testSnapshot.agents) delete agent.memory
        window.notifyActivity()
      })
      await page.waitForFunction(() => document.querySelectorAll('.lane-memory').length === 0)
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  }
})
