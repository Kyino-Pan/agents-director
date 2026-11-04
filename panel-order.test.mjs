import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshot } from './panel.fixture.mjs'
import { pageFor } from './panel-test-browser.mjs'

for (const [width, dark] of [
  [1100, false],
  [390, true]
]) {
  test(`shorter-links toggle preserves identities and restores activity order at ${width}px`, async () => {
    const data = structuredClone(snapshot)
    data.agents = ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      label: `Agent ${id}`,
      projectId: 'p',
      projectName: 'Project',
      segments: [{ start: data.now - (i + 1) * 1000, end: data.now, state: 'done' }]
    }))
    data.agents[1].parentId = 'd'
    data.agents[1].spawnedAt = data.now - 3600000
    data.messages = [
      { id: 'edge', from: 'a', to: 'd', at: data.now - 3600000, subject: 'Coordination' }
    ]
    const { page, errors } = await pageFor({ width, dark, data })
    try {
      const lanes = () =>
        page
          .locator('.lane')
          .evaluateAll((elements) => elements.map((element) => element.dataset.agent))
      const toggle = page.getByRole('button', { name: 'Shorter links', exact: true })
      const lineLength = () =>
        page
          .locator('.spawn, .message-path')
          .evaluateAll((paths) => paths.reduce((sum, path) => sum + path.getTotalLength(), 0))
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
      assert.deepEqual(await lanes(), ['a', 'b', 'c', 'd'])
      const before = await lineLength()
      await toggle.focus()
      await page.keyboard.press('Space')
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
      assert.deepEqual(await lanes(), ['a', 'd', 'b', 'c'])
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((animation) => animation.finished))
      )
      assert.ok((await lineLength()) < before)
      await page.locator('[data-message="edge"]').dispatchEvent('click')
      assert.equal(await page.locator('#detail-heading').textContent(), 'Coordination')
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.evaluate(() => window.notifyActivity())
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
      assert.deepEqual(await lanes(), ['a', 'd', 'b', 'c'])
      await toggle.click()
      assert.deepEqual(await lanes(), ['a', 'b', 'c', 'd'])
      await toggle.click()
      await page.getByRole('slider', { name: 'Window' }).focus()
      await page.keyboard.press('Home')
      assert.deepEqual(await lanes(), ['a', 'b', 'c', 'd'])
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('.spawn, .message-path').count(), 0)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      if (process.env.ACTIVITY_SCREENSHOTS) {
        await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
        await page.screenshot({
          path: join(process.env.ACTIVITY_SCREENSHOTS, `lane-order-${width}.png`)
        })
      }
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  })
}

test('reorder motion keeps lanes, activity and connector endpoints aligned, including interruption and reduced motion', async () => {
  const data = structuredClone(snapshot)
  data.agents = ['a', 'b', 'c', 'd'].map((id, i) => ({
    id,
    label: `Agent ${id}`,
    projectId: 'p',
    projectName: 'Project',
    segments: [{ start: data.now - (i + 1) * 1000, end: data.now, state: 'done' }]
  }))
  data.agents[1].parentId = 'd'
  data.agents[1].spawnedAt = data.now - 3600000
  data.messages = [
    { id: 'edge', from: 'a', to: 'd', at: data.now - 3600000, subject: 'Coordination' }
  ]
  const { page, errors } = await pageFor({ data })
  try {
    const transition = await page.evaluate(() => {
      document.getElementById('shorten-links').click()
      const animations = document.getAnimations()
      for (const animation of animations) {
        animation.pause()
        animation.currentTime = 100
      }
      const center = (id) => {
        const box = document.querySelector(`.lane[data-agent="${id}"]`).getBoundingClientRect()
        return (
          box.top + box.height / 2 - document.getElementById('lanes').getBoundingClientRect().top
        )
      }
      const d = center('d')
      const bar = document
        .querySelector('.segment-target[data-agent="d"] .segment-hit')
        .getBoundingClientRect()
      const barCenter =
        bar.top + bar.height / 2 - document.getElementById('chart').getBoundingClientRect().top
      const line = document.querySelector('.message-path')
      const endpoint = line.getPointAtLength(line.getTotalLength()).y
      const spawn = document.querySelector('.spawn')
      const parent = spawn.getPointAtLength(0).y
      const child = spawn.getPointAtLength(spawn.getTotalLength()).y
      document.getElementById('shorten-links').click()
      for (const animation of document.getAnimations()) {
        animation.pause()
        animation.currentTime = 0
      }
      return {
        count: animations.length,
        d,
        barCenter,
        endpoint,
        parent,
        child,
        b: center('b'),
        interrupted: center('d')
      }
    })
    assert.ok(transition.count >= 6)
    assert.ok(transition.d > 78 && transition.d < 142)
    for (const y of [
      transition.barCenter,
      transition.endpoint,
      transition.parent,
      transition.interrupted
    ]) {
      assert.ok(Math.abs(y - transition.d) < 0.1, JSON.stringify(transition))
    }
    assert.ok(Math.abs(transition.child - transition.b) < 0.1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Shorter links' }).click()
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0)
    assert.deepEqual(await page.locator('.lane-name').allTextContents(), [
      'Agent a',
      'Agent d',
      'Agent b',
      'Agent c'
    ])
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('horizontal gestures keep existing lanes still while new activity and connections enter immediately', async () => {
  const data = structuredClone(snapshot)
  const hour = 3600000
  data.agents = [
    { id: 'a', end: data.now - 2 * hour },
    { id: 'b', end: data.now - hour },
    { id: 'older', end: data.now - 25 * hour }
  ].map(({ id, end }) => ({
    id,
    label: `Agent ${id}`,
    projectId: 'p',
    projectName: 'Project',
    segments: [
      {
        start: id === 'older' ? end - hour : data.now - 72 * hour,
        end,
        state: 'working'
      }
    ]
  }))
  data.agents[2].parentId = 'a'
  data.agents[2].spawnedAt = data.now - 25 * hour
  data.messages = [{ id: 'older-message', from: 'older', to: 'a', at: data.now - 25 * hour }]
  const { page, errors } = await pageFor({ data })
  try {
    const lanes = () =>
      page.locator('.lane').evaluateAll((elements) => elements.map((el) => el.dataset.agent))
    assert.deepEqual(await lanes(), ['b', 'a'])
    const period = await page.locator('#period').textContent()
    const during = await page.evaluate(async () => {
      const chart = document.getElementById('chart-scroll')
      const states = []
      for (const deltaX of [-50, -25, 75, -65]) {
        chart.dispatchEvent(new WheelEvent('wheel', { deltaX, cancelable: true, bubbles: true }))
        await new Promise(requestAnimationFrame)
        states.push({
          ids: [...document.querySelectorAll('.lane')].map((lane) => lane.dataset.agent),
          olderBars: document.querySelectorAll('.segment-target[data-agent="older"]').length,
          messages: document.querySelectorAll('[data-message="older-message"]').length,
          spawns: document.querySelectorAll('.spawn').length,
          messageX: document.querySelector('[data-message="older-message"]')?.dataset.x,
          centers: [...document.querySelectorAll('.lane')]
            .slice(0, 2)
            .map((lane) => lane.getBoundingClientRect().top),
          motion: document.getAnimations().filter((animation) => animation.id === 'lane-reorder')
            .length
        })
      }
      window.testSnapshot.agents[0].label = 'Updated while scrolling'
      window.notifyActivity()
      await Promise.resolve()
      await Promise.resolve()
      states.push({
        ids: [...document.querySelectorAll('.lane')].map((lane) => lane.dataset.agent),
        motion: document.getAnimations().filter((animation) => animation.id === 'lane-reorder')
          .length
      })
      return states
    })
    for (const state of during) {
      assert.deepEqual(state.ids, ['b', 'a', 'older'])
      assert.equal(state.motion, 0)
    }
    for (const index of [0, 1, 3]) {
      assert.equal(during[index].olderBars, 1)
      assert.equal(during[index].messages, 1)
      assert.equal(during[index].spawns, 1)
      assert.deepEqual(during[index].centers, during[0].centers)
    }
    assert.notEqual(during[0].messageX, during[1].messageX)
    assert.equal(during[2].olderBars, 0)
    assert.equal(during[2].messages, 0)
    assert.equal(during[2].spawns, 0)
    assert.notEqual(await page.locator('#period').textContent(), period)
    await page.getByText('Updated while scrolling', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('.lane')?.dataset.agent === 'a')
    assert.deepEqual(await lanes(), ['a', 'b', 'older'])
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished))
    )
    assert.equal(
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.lane')].map((lane) =>
          lane.getBoundingClientRect()
        )
        return rows.every((row, index) => !index || row.top >= rows[index - 1].bottom)
      }),
      true
    )
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
