import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pageFor } from './panel-test-browser.mjs'
import { snapshot } from './panel.fixture.mjs'

test('window size and sort mode survive a reopened frame and short source history does not overwrite them', async () => {
  const preferences = new Map()
  const first = await pageFor({ preferences })
  try {
    await first.page.getByRole('slider', { name: 'Window' }).focus()
    await first.page.keyboard.press('End')
    await first.page.getByRole('button', { name: 'Shorter links' }).click()
    await first.page.waitForFunction(
      async () =>
        (await window.orca.storage.get('view:window-hours')) === 168 &&
        (await window.orca.storage.get('view:compact-lanes')) === true
    )
  } finally {
    await first.page.close()
  }
  const data = { ...structuredClone(snapshot), windowStart: snapshot.now - 24 * 3600000 }
  const short = await pageFor({ data, preferences })
  try {
    assert.equal(await short.page.locator('#zoom-value').textContent(), '24h')
    assert.equal(await short.page.locator('#shorten-links').getAttribute('aria-pressed'), 'true')
    assert.equal(preferences.get('view:window-hours'), 168)
  } finally {
    await short.page.close()
  }
  const reopened = await pageFor({ preferences })
  try {
    assert.equal(await reopened.page.locator('#zoom-value').textContent(), '7d')
    assert.equal(await reopened.page.locator('#shorten-links').getAttribute('aria-pressed'), 'true')
    await reopened.page.getByRole('slider', { name: 'Window' }).focus()
    await reopened.page.keyboard.press('Home')
    await reopened.page.waitForFunction(
      async () => (await window.orca.storage.get('view:window-hours')) === 1 / 12
    )
    assert.equal(preferences.get('view:window-hours'), 1 / 12)
    assert.deepEqual(reopened.errors, [])
  } finally {
    await reopened.page.close()
  }
})

test('panning into an empty interval retains the chart and can pan straight back', async () => {
  const data = structuredClone(snapshot)
  data.agents = [
    {
      id: 'recent',
      label: 'Recent agent',
      segments: [{ start: data.now - 3600000, end: data.now, state: 'working' }]
    }
  ]
  data.messages = []
  const { page, errors } = await pageFor({ data })
  try {
    const chart = page.locator('#chart-scroll')
    const before = await page.locator('#period').textContent()
    await chart.evaluate((element) =>
      element.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: -1200,
          shiftKey: true,
          cancelable: true,
          bubbles: true
        })
      )
    )
    await page.locator('#view-empty').waitFor({ state: 'visible' })
    assert.equal(await chart.isVisible(), true)
    assert.equal(await page.locator('#axis').isVisible(), true)
    assert.equal(await page.locator('.label-heading').isVisible(), true)
    assert.ok((await chart.boundingBox()).height > 100)
    assert.notEqual(await page.locator('#period').textContent(), before)
    if (process.env.ACTIVITY_SCREENSHOTS) {
      await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: join(process.env.ACTIVITY_SCREENSHOTS, 'empty-window.png') })
    }
    await chart.evaluate((element) =>
      element.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: 1200,
          shiftKey: true,
          cancelable: true,
          bubbles: true
        })
      )
    )
    assert.equal(await page.locator('#period').textContent(), before)
    assert.equal(await page.locator('#view-empty').isHidden(), true)
    assert.equal(await page.locator('.lane-name').textContent(), 'Recent agent')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
