import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageFor } from './panel-test-browser.mjs'

test('a refresh never restores stale lane focus when the plugin document is unfocused', async () => {
  const { page, errors } = await pageFor()
  try {
    await page.evaluate(() => {
      document.querySelector('.lane').focus()
      // Electron guests can retain activeElement after focus moves to the host.
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
      window.refreshFocusCalls = []
      const focus = HTMLElement.prototype.focus
      HTMLElement.prototype.focus = function (...args) {
        window.refreshFocusCalls.push(this.dataset.key ?? this.id)
        return focus.apply(this, args)
      }
      window.testSnapshot = { ...window.testSnapshot, messages: [] }
      window.notifyActivity()
    })
    await page.waitForFunction(() => document.querySelectorAll('.message-target').length === 0)
    assert.deepEqual(await page.evaluate(() => window.refreshFocusCalls), [])
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('a refresh preserves keyboard navigation when the plugin still owns focus', async () => {
  const { page, errors } = await pageFor()
  try {
    const key = await page.evaluate(() => {
      const lane = document.querySelector('.lane')
      lane.focus()
      if (!document.hasFocus()) {
        throw new Error('The plugin document must own focus for this scenario')
      }
      window.testSnapshot = { ...window.testSnapshot, messages: [] }
      window.notifyActivity()
      return lane.dataset.key
    })
    await page.waitForFunction(() => document.querySelectorAll('.message-target').length === 0)
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), key)
    await page.keyboard.press('Enter')
    await page.locator('#detail').waitFor({ state: 'visible' })
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('viewport resizing settles without redraws driven by the chart content size', async () => {
  const { page, errors } = await pageFor()
  try {
    for (const [width, height] of [
      [900, 600],
      [1400, 1000],
      [390, 820]
    ]) {
      await page.setViewportSize({ width, height })
      await page.waitForFunction(() => {
        const chart = document.getElementById('chart')
        const viewport = document.getElementById('chart-scroll')
        return (
          chart.viewBox.baseVal.width ===
            Math.max(600, document.getElementById('plot').clientWidth) &&
          chart.viewBox.baseVal.height >= viewport.clientHeight - 34
        )
      })
      assert.equal(
        await page.evaluate(async () => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
          const lane = document.querySelector('.lane')
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
          return lane.isConnected
        }),
        true
      )
    }
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
