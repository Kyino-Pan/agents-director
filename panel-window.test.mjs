import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { pageFor } from './panel-test-browser.mjs'
import { snapshot } from './panel.fixture.mjs'

test('aligned window controls and fixed footer fit both themes at desktop and narrow sizes', async () => {
  for (const [width, height] of [
    [1280, 820],
    [360, 640]
  ]) {
    for (const dark of [false, true]) {
      const { page, errors } = await pageFor({ width, height, dark })
      try {
        await page.locator('#notice').waitFor({ state: 'visible' })
        const layout = await page.evaluate(() => {
          const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
          const ticks = [...document.querySelectorAll('.zoom-tick:not([hidden])')].map((tick) =>
            tick.getBoundingClientRect()
          )
          return {
            centers: ['#zoom', '#range-start', '#range-end'].map((selector) => {
              const box = rect(selector)
              return box.y + box.height / 2
            }),
            footerBottom: rect('.footer').bottom,
            footerTop: rect('.footer').top,
            chartBottom: rect('#chart-scroll').bottom,
            overflow: document.documentElement.scrollWidth > innerWidth,
            ticksFit: ticks.every(
              (box, index) =>
                box.left >= 0 &&
                box.right <= innerWidth &&
                (!index || box.left >= ticks[index - 1].right)
            ),
            tickCount: ticks.length,
            inlineLabels: [...document.querySelectorAll('.range-controls label')].every(
              (label) =>
                label.getBoundingClientRect().height ===
                label.querySelector('input').getBoundingClientRect().height
            )
          }
        })
        assert.equal(layout.overflow, false)
        assert.equal(layout.inlineLabels, true)
        assert.ok(layout.ticksFit)
        assert.ok(layout.tickCount >= 3 && layout.tickCount <= 5)
        assert.equal(layout.footerBottom, height)
        assert.ok(Math.abs(layout.chartBottom - layout.footerTop) <= 1)
        if (width === 1280) {
          assert.ok(Math.max(...layout.centers) - Math.min(...layout.centers) <= 1)
          assert.equal(layout.tickCount, 5)
        }
        if (process.env.ACTIVITY_SCREENSHOTS) {
          await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
          await page.screenshot({
            path: join(
              process.env.ACTIVITY_SCREENSHOTS,
              `controls-${width}-${dark ? 'dark' : 'light'}.png`
            )
          })
        }
        await page.locator('#notice').click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Data sources' }).click()
        assert.equal(await page.locator('#sources-dialog').isVisible(), true)
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    }
  }
})

test('footer stays at the bottom during loading, empty history and failure', async () => {
  let resolveSnapshot
  const pending = new Promise((resolve) => {
    resolveSnapshot = resolve
  })
  const { page, errors } = await pageFor({ width: 360, height: 640, getSnapshot: () => pending })
  try {
    assert.match(await page.locator('#summary').textContent(), /Loading/)
    assert.equal(await page.locator('#zoom').isDisabled(), true)
    const footerBottom = () =>
      page.locator('.footer').evaluate((footer) => footer.getBoundingClientRect().bottom)
    assert.equal(await footerBottom(), 640)
    resolveSnapshot({ ...snapshot, agents: [], messages: [] })
    await page.getByText('No activity observed yet', { exact: true }).waitFor()
    assert.equal(await footerBottom(), 640)
    // The hidden chart cannot signal width changes while history is empty.
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 640 })
      await page.waitForFunction(
        (count) => document.querySelectorAll('.zoom-tick:not([hidden])').length === count,
        width === 1280 ? 5 : 3,
        { timeout: 1000 }
      )
    }
    await page.evaluate(() => {
      window.testFail = true
      window.notifyActivity()
    })
    await page.locator('#failure').waitFor({ state: 'visible' })
    assert.equal(await footerBottom(), 640)
    assert.equal(await page.locator('.footer #failure, .footer #navigation-status').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    resolveSnapshot(snapshot)
    await page.close()
  }
})

test('round ticks use the slider log scale and select exact persisted durations without resetting a pan', async () => {
  const preferences = new Map()
  const { page, errors } = await pageFor({ width: 1280, preferences })
  try {
    await page.locator('#notice').waitFor({ state: 'visible' })
    for (const hours of [0.25, 1, 6, 24, 168]) {
      const tick = page.locator(`.zoom-tick[data-hours="${hours}"]`)
      const fraction = Math.log(hours / (1 / 12)) / Math.log(168 / (1 / 12))
      assert.ok(
        Math.abs(
          (await tick.evaluate((button) => parseFloat(button.style.left))) - fraction * 100
        ) < 0.001
      )
      await tick.click()
      await page.waitForFunction(
        async (hours) => (await window.orca.storage.get('view:window-hours')) === hours,
        hours
      )
      assert.equal(await page.locator('#zoom').inputValue(), String(Math.round(fraction * 1000)))
      const from = Date.parse(await page.locator('#range-start').inputValue())
      const to = Date.parse(await page.locator('#range-end').inputValue())
      assert.equal((to - from) / 3600000, hours)
      assert.equal(await tick.evaluate((button) => button === document.activeElement), true)
    }
    await page.locator('.zoom-tick[data-hours="6"]').click()
    await page
      .locator('#chart-scroll')
      .evaluate((chart) =>
        chart.dispatchEvent(
          new WheelEvent('wheel', { deltaX: -200, shiftKey: true, cancelable: true })
        )
      )
    const end = await page.locator('#range-end').inputValue()
    await page.locator('.zoom-tick[data-hours="1"]').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('#range-end').inputValue(), end)
    await page.getByRole('searchbox').fill('Coordinator')
    assert.equal(await page.locator('#range-end').inputValue(), end)
    // Arbitrary native range values stay continuous instead of snapping to a preset.
    await page.locator('#zoom').fill('500')
    const smoothHours = (1 / 12) * (168 / (1 / 12)) ** 0.5
    await page.waitForFunction(
      async (value) => (await window.orca.storage.get('view:window-hours')) === value,
      smoothHours
    )
    await page.locator('.zoom-tick[data-hours="6"]').click()
    await page.waitForFunction(
      async () => (await window.orca.storage.get('view:window-hours')) === 6
    )
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
  const reopened = await pageFor({ preferences })
  try {
    await reopened.page.locator('#notice').waitFor({ state: 'visible' })
    assert.equal(await reopened.page.locator('#zoom-value').textContent(), '6h')
    for (const minutes of [21, 2]) {
      await reopened.page.evaluate((minutes) => {
        window.testSnapshot.windowStart = window.testSnapshot.now - minutes * 60000
        window.notifyActivity()
      }, minutes)
      await reopened.page.waitForFunction(
        (minutes) => document.getElementById('zoom-limit').textContent === `${minutes}m`,
        minutes
      )
      assert.deepEqual(
        await reopened.page.locator('.zoom-tick:not([hidden])').allTextContents(),
        minutes === 21 ? ['15m'] : []
      )
      assert.equal(preferences.get('view:window-hours'), 6)
      assert.equal(await reopened.page.locator('#zoom').isDisabled(), minutes === 2)
    }
    assert.deepEqual(reopened.errors, [])
  } finally {
    await reopened.page.close()
  }
})

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
    await page.locator('#view-empty').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#view-empty').isHidden(), true)
    assert.equal(await page.locator('.lane-name').textContent(), 'Recent agent')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
