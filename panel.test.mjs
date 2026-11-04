import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startPreview } from './preview.mjs'
import { snapshot } from './panel.fixture.mjs'
import { browser, pageFor } from './panel-test-browser.mjs'

test('timeline filters, range, keyboard inspection and literal message text', async () => {
  const { page, errors } = await pageFor()
  assert.equal(await page.locator('.lane').count(), 6)
  assert.equal(await page.locator('.message-target').count(), 7)
  assert.equal(await page.locator('.spawn').count(), 4)
  await page.locator('[data-message="m7"]').focus()
  await page.keyboard.press('Enter')
  assert.match(await page.locator('#detail-body').textContent(), /<img src=x/)
  assert.equal(await page.locator('#detail img').count(), 0)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#detail').isHidden(), true)
  await page.getByRole('slider', { name: 'Window' }).fill('326')
  assert.equal(await page.locator('.message-target').count(), 1)
  await page.getByRole('searchbox').fill('activity-ui')
  assert.equal(await page.locator('.lane').count(), 1)
  assert.equal(await page.locator('.message-target').count(), 0)
  await page.getByRole('searchbox').fill('missing-agent')
  assert.match(await page.locator('#view-empty').textContent(), /No activity in this view/)
  assert.deepEqual(errors, [])
  await page.close()
})

test('pause freezes inspection while incoming snapshots remain available on resume', async () => {
  const { page, errors } = await pageFor()
  await page.getByRole('button', { name: 'Pause view' }).click()
  await page.evaluate(() => {
    window.testSnapshot = {
      ...window.testSnapshot,
      agents: window.testSnapshot.agents.slice(0, 2),
      now: window.testSnapshot.now + 30_000
    }
    window.notifyActivity()
  })
  assert.equal(await page.locator('.lane').count(), 6)
  await page.getByRole('button', { name: 'Resume live' }).click()
  assert.equal(await page.locator('.lane').count(), 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('empty sources, connection failure and retry recovery are explicit', async () => {
  const { page, errors } = await pageFor({ fail: true })
  assert.match(await page.locator('#failure').textContent(), /Worker unavailable/)
  await page.evaluate(() => {
    window.testFail = false
    window.testSnapshot = { ...window.testSnapshot, agents: [], messages: [] }
  })
  await page.getByRole('button', { name: 'Retry' }).click()
  await page.locator('#failure').waitFor({ state: 'hidden' })
  assert.match(await page.locator('#empty').textContent(), /No activity observed yet/)
  assert.equal(await page.locator('#sources-dialog').isVisible(), false)
  await page.locator('h1').click({ button: 'right' })
  assert.deepEqual(errors, [])
  assert.equal(
    await page.locator('#activity-menu').evaluate((element) => element.matches(':popover-open')),
    true
  )
  await page.getByRole('menuitem', { name: 'Data sources' }).click()
  await page.locator('#sources-dialog').waitFor({ state: 'visible' })
  assert.match(await page.locator('#source-list').textContent(), /disconnected hosts/)
  assert.deepEqual(errors, [])
  await page.close()
})

test('context actions and platform click navigate the selected agent, preserving ordinary inspection', async () => {
  const { page, errors } = await pageFor()
  const agentId = snapshot.agents[0].id
  const lane = page.locator(`.lane[data-agent="${agentId}"]`)
  await lane.click()
  assert.equal(await page.locator('#detail').isVisible(), true)
  assert.equal(await page.evaluate(() => window.navigationRequest), undefined)
  await lane.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Go to terminal' }).click()
  assert.deepEqual(await page.evaluate(() => window.navigationRequest), { agentId })
  await page.evaluate(() => {
    window.navigationRequest = null
    window.navigationError = 'This terminal is closed.'
  })
  const modifier = await page.evaluate(() =>
    navigator.userAgent.includes('Mac') ? 'Meta' : 'Control'
  )
  await lane.click({ modifiers: [modifier] })
  await page.getByText('This terminal is closed.', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.navigationRequest), { agentId })
  await lane.focus()
  await page.keyboard.press('Shift+F10')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.locator('#sources-dialog').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#sources-dialog').isVisible(), false)
  await page.locator(`.lane[data-agent="${snapshot.agents[1].id}"]`).click({ button: 'right' })
  assert.equal(await page.getByRole('menuitem', { name: 'Go to terminal' }).isDisabled(), true)
  assert.deepEqual(errors, [])
  await page.close()
})

test('non-Mac click handling uses Control to open terminals', async () => {
  const { page, errors } = await pageFor({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  })
  await page
    .locator(`.lane[data-agent="${snapshot.agents[0].id}"]`)
    .dispatchEvent('click', { ctrlKey: true })
  assert.deepEqual(await page.evaluate(() => window.navigationRequest), {
    agentId: snapshot.agents[0].id
  })
  assert.equal(await page.locator('#detail').isVisible(), false)
  assert.deepEqual(errors, [])
  await page.close()
})

test('light, dark and sidebar layouts contain page overflow and preserve timeline scrolling', async () => {
  const output = process.env.ACTIVITY_SCREENSHOTS
  if (output) {
    await mkdir(output, { recursive: true })
  }
  for (const [name, width, dark] of [
    ['light', 1280, false],
    ['dark', 1280, true],
    ['sidebar-light', 360, false],
    ['sidebar-dark', 360, true]
  ]) {
    const { page, errors } = await pageFor({ width, dark })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    if (width < 480) {
      assert.equal(
        await page
          .locator('#chart-scroll')
          .evaluate((element) => element.scrollWidth > element.clientWidth),
        true
      )
      await page.locator('#chart-scroll').evaluate((element) => {
        element.scrollLeft = 200
      })
      assert.equal(Math.round((await page.locator('.labels').boundingBox()).x), 0)
    }
    if (output) {
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
      await page.locator('.lane').first().click({ button: 'right' })
      await page.screenshot({ path: `${output}/${name}-menu.png`, fullPage: true })
      await page.getByRole('menuitem', { name: 'Data sources' }).click()
      await page.screenshot({ path: `${output}/${name}-sources.png`, fullPage: true })
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.locator('.lane').first().click()
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      )
      await page.screenshot({ path: `${output}/${name}-identity.png`, fullPage: true })
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('dense timelines fill the available height and inspection does not shrink the lanes', async () => {
  const data = {
    ...snapshot,
    limited: false,
    messages: [],
    agents: Array.from({ length: 40 }, (_, index) => ({
      ...snapshot.agents[0],
      id: `dense-${index}`,
      label: `Agent ${String(index).padStart(2, '0')}`
    }))
  }
  for (const width of [1100, 360]) {
    const { page, errors } = await pageFor({ width, height: 1020, data })
    const chart = page.locator('#chart-scroll')
    const before = await chart.boundingBox()
    assert.ok(
      before.height > 510,
      `Timeline uses more than half the 1020px viewport at width ${width}`
    )
    assert.ok(Math.abs(before.y + before.height - 1020) <= 2)
    const visibleRows = await page.locator('.lane').evaluateAll(
      (lanes) =>
        lanes.filter((lane) => {
          const row = lane.getBoundingClientRect()
          const viewport = document.getElementById('chart-scroll').getBoundingClientRect()
          return row.top >= viewport.top && row.bottom <= viewport.bottom
        }).length
    )
    assert.ok(visibleRows > 13)
    await page.locator('.lane').first().click()
    assert.equal(await page.locator('#detail').isVisible(), true)
    assert.deepEqual(await chart.boundingBox(), before)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
      true
    )
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('#detail').isVisible(), false)
    if (process.env.ACTIVITY_SCREENSHOTS) {
      await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: `${process.env.ACTIVITY_SCREENSHOTS}/dense-${width}.png` })
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('names stay primary while full identities remain searchable, inspectable and copyable', async () => {
  const { page, errors } = await pageFor({ width: 360 })
  const agent = snapshot.agents[0]
  assert.equal(await page.locator('.lane-name').first().textContent(), agent.label)
  assert.equal(
    await page
      .locator('.lane')
      .first()
      .textContent()
      .then((text) => text.includes(agent.id)),
    false
  )
  for (const query of [
    agent.id,
    agent.sessionId,
    agent.providerSessionId,
    agent.paneKey,
    agent.terminalHandle,
    agent.taskId
  ]) {
    await page.getByRole('searchbox').fill(query)
    assert.equal(await page.locator('.lane').count(), 1)
    assert.equal(await page.locator('.lane-name').textContent(), agent.label)
  }
  await page.locator('.lane').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#detail-heading').textContent(), agent.label)
  assert.equal(await page.locator('#identity').getAttribute('open'), '')
  for (const value of [
    agent.id,
    agent.sessionId,
    agent.providerSessionId,
    agent.paneKey,
    agent.terminalHandle,
    agent.runId,
    agent.dispatchId,
    agent.taskId
  ]) {
    assert.match(await page.locator('#identity-list').textContent(), new RegExp(value))
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: 'Copy agent ID' }).click()
  await page.getByText('Agent ID copied.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), agent.id)
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Not permitted')
        }
      }
    })
  )
  await page.getByRole('button', { name: 'Copy agent ID' }).click()
  await page.getByText('Clipboard unavailable.', { exact: false }).waitFor()
  assert.equal(await page.evaluate(() => window.getSelection().toString()), agent.id)
  await page.keyboard.press('Escape')
  assert.equal(
    await page.locator('.lane').evaluate((element) => element === document.activeElement),
    true
  )
  await page.getByRole('searchbox').fill('')
  await page.locator('[data-message="m2"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('#identity summary').click()
  assert.match(
    await page.locator('#identity-list').textContent(),
    new RegExp(snapshot.agents[1].id)
  )
  assert.match(await page.locator('#detail-meta').textContent(), /Coordinator → Activity interface/)
  assert.deepEqual(errors, [])
  await page.close()
})

test('old payloads and duplicate names retain separate stable identities across live updates', async () => {
  const data = structuredClone(snapshot)
  data.agents = data.agents.slice(0, 3).map(({ id, segments }) => ({ id, segments }))
  data.agents[0].label = 'Same name'
  data.agents[1].label = 'Same name'
  const { page, errors } = await pageFor({ data })
  assert.deepEqual(await page.locator('.lane-name').allTextContents(), [
    'Same name',
    'Unnamed agent',
    'Same name'
  ])
  await page.locator(`.lane[data-agent="${data.agents[1].id}"]`).click()
  assert.equal(await page.locator('[data-identity-id]').textContent(), data.agents[1].id)
  await page.evaluate(() => {
    window.testSnapshot.agents[1].label = 'Renamed reviewer'
    window.notifyActivity()
  })
  await page.getByRole('heading', { name: 'Renamed reviewer' }).waitFor()
  assert.equal(await page.locator('[data-identity-id]').textContent(), data.agents[1].id)
  await page.keyboard.press('Escape')
  await page.getByRole('searchbox').fill(data.agents[2].id)
  await page.locator('.lane').click()
  assert.equal(await page.locator('#detail-heading').textContent(), 'Unnamed agent')
  assert.equal(await page.locator('[data-identity-id]').textContent(), data.agents[2].id)
  assert.deepEqual(errors, [])
  await page.close()
})

test('thin history tracks keep accessible states and generous targets in both host themes', async () => {
  for (const dark of [false, true]) {
    const { page, errors } = await pageFor({ dark })
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      dark ? 'dark' : 'light'
    )
    assert.equal(await page.locator('#chart text, #chart pattern').count(), 0)
    for (const state of ['working', 'blocked', 'waiting', 'done', 'unknown']) {
      const segment = page.locator(`.segment.${state}`).first()
      const dimensions = await segment.evaluate((element) => ({
        visible: element.getClientRects().length > 0,
        height: element.getBoundingClientRect().height,
        hitHeight: element.parentElement.querySelector('.segment-hit').getBoundingClientRect()
          .height
      }))
      const target = segment.locator('..')
      assert.ok(dimensions.visible)
      assert.ok(dimensions.height <= 6)
      assert.ok(dimensions.hitHeight >= 24)
      assert.equal(await segment.evaluate((element) => getComputedStyle(element).stroke), 'none')
      await target.focus()
      await page.keyboard.press('Enter')
      assert.match(
        await page.locator('#detail-heading').textContent(),
        new RegExp(state === 'unknown' ? 'Unobserved' : state, 'i')
      )
      if (state === 'unknown') {
        assert.match(
          await page.locator('#detail-body').textContent(),
          /Missing or stale logs cannot confirm continued work/
        )
        assert.match(
          await page.locator('#detail-body').textContent(),
          /Last observed: Working through/
        )
      }
      await page.keyboard.press('Escape')
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
})

test('window slider spans five minutes to seven days and clamps to older snapshots', async () => {
  const { page, errors } = await pageFor()
  const slider = page.getByRole('slider', { name: 'Window' })
  assert.equal(await page.locator('#zoom-value').textContent(), '24h')
  const initialCount = await page.locator('.segment-target').count()
  await slider.focus()
  await page.keyboard.press('End')
  assert.equal(await page.locator('#zoom-value').textContent(), '7d')
  assert.ok((await page.locator('.segment-target').count()) > initialCount)
  assert.match(await page.locator('#axis').textContent(), /Oct/)
  assert.match(await slider.getAttribute('aria-valuetext'), /168h/)
  if (process.env.ACTIVITY_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.ACTIVITY_SCREENSHOTS}/seven-days.png`,
      fullPage: true
    })
  }
  await slider.fill('835')
  const ticks = await page.locator('#axis span').allTextContents()
  assert.equal(new Set(ticks).size, ticks.length)
  await slider.focus()
  await page.keyboard.press('Home')
  assert.equal(await page.locator('#zoom-value').textContent(), '5m')
  assert.equal(await page.locator('.message-target').count(), 0)
  await page.evaluate(() => {
    window.testSnapshot.windowStart = window.testSnapshot.now - 24 * 3_600_000
    window.notifyActivity()
  })
  await slider.focus()
  await page.keyboard.press('End')
  assert.equal(await page.locator('#zoom-limit').textContent(), '24h')
  assert.equal(await page.locator('#zoom-value').textContent(), '24h')
  await page.evaluate(() => {
    window.testSnapshot.windowStart = window.testSnapshot.now - 30 * 60_000
    window.notifyActivity()
  })
  await page.getByText('30m', { exact: true }).first().waitFor()
  await slider.focus()
  await page.keyboard.press('End')
  assert.equal(await page.locator('#zoom-value').textContent(), '30m')
  await page.keyboard.press('Home')
  assert.equal(await page.locator('#zoom-value').textContent(), '5m')

  assert.deepEqual(errors, [])
  await page.close()
})

test('loopback preview serves the identity module and follows system appearance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-activity-preview-'))
  const preview = await startPreview({ directories: [directory] })
  try {
    for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({ colorScheme })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const moduleResponse = page.waitForResponse((response) =>
        response.url().endsWith('/panel-identity.mjs')
      )
      await page.goto(preview.url)
      assert.equal((await moduleResponse).status(), 200)
      await page.getByText('No activity observed yet', { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
        colorScheme
      )
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await preview.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('project bands preserve cross-project messages and compressed messages remain inspectable', async () => {
  const data = structuredClone(snapshot)
  data.messages.push({
    ...data.messages[0],
    id: 'nearby',
    at: data.messages[0].at + 1000,
    subject: 'Second message'
  })
  data.messages.push({
    ...data.messages[0],
    id: 'cross-project',
    to: data.agents.find((agent) => agent.projectId === 'docs').id,
    subject: 'Across projects'
  })
  const { page, errors } = await pageFor({ data })
  assert.deepEqual(await page.locator('.project-heading').allTextContents(), [
    'Orca',
    'Documentation'
  ])
  const compressed = page.locator('[data-message="m1"]')
  assert.equal(await compressed.locator('.message-count').textContent(), '2')
  await compressed.dispatchEvent('click')
  await page.getByRole('button', { name: /Second message/ }).click()
  assert.equal(await page.locator('#detail-heading').textContent(), 'Second message')
  const cross = page.locator('[data-message-ids*="cross-project"] .message-path')
  assert.match(await cross.getAttribute('d'), / L /)
  assert.deepEqual(errors, [])
  await page.close()
})

test('ordinary wheel scrolls while modified wheel changes the window gradually', async () => {
  const { page, errors } = await pageFor()
  const chart = page.locator('#chart-scroll')
  const before = await page.locator('#period').textContent()
  const prevented = await chart.evaluate((element) => {
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  assert.equal(prevented, false)
  await chart.hover()
  await page.mouse.wheel(0, 180)
  assert.equal(await page.locator('#period').textContent(), before)
  await chart.evaluate((element) =>
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, ctrlKey: true, cancelable: true }))
  )
  assert.notEqual(await page.locator('#period').textContent(), before)
  assert.match(await page.locator('#zoom-value').textContent(), /^25h/)
  assert.deepEqual(errors, [])
  await page.close()
})

test('project bands place frequently communicating projects next to one another', async () => {
  const data = structuredClone(snapshot)
  const other = {
    ...data.agents[0],
    id: 'other-project',
    projectId: 'other',
    projectName: 'Other',
    segments: []
  }
  data.agents.splice(5, 0, other)
  data.messages.push({
    ...data.messages[0],
    id: 'between-projects',
    from: data.agents[0].id,
    to: data.agents.at(-1).id
  })
  const { page, errors } = await pageFor({ data })
  const names = await page.locator('.project-heading').allTextContents()
  assert.equal(Math.abs(names.indexOf('Orca') - names.indexOf('Documentation')), 1)
  assert.deepEqual(errors, [])
  await page.close()
})

test('only agents with evidence in the selected time window are visible', async () => {
  const data = structuredClone(snapshot)
  const now = data.now
  const hour = 3_600_000
  const base = data.agents[0]
  const agent = (id, segments) => ({
    ...base,
    id,
    label: `Agent ${id}`,
    parentId: undefined,
    spawnedAt: undefined,
    segments
  })
  data.agents = [
    agent('old-work', [{ start: now - 50 * hour, end: now - 49 * hour, state: 'working' }]),
    agent('old-done', [{ start: now - 50 * hour, end: now, state: 'done' }]),
    agent('unobserved', [{ start: now - hour, end: now, state: 'unknown' }]),
    agent('current-work', [{ start: now - 2 * hour, end: now, state: 'working' }]),
    agent('message-only', [{ start: now - hour, end: now, state: 'unknown' }])
  ]
  data.messages = [
    { ...data.messages[0], from: 'message-only', to: 'current-work', at: now - hour }
  ]
  const { page, errors } = await pageFor({ data })
  assert.deepEqual(await page.locator('.lane-name').allTextContents(), [
    'Agent current-work',
    'Agent message-only'
  ])
  await page.getByRole('slider', { name: 'Window' }).focus()
  await page.keyboard.press('End')
  assert.deepEqual(await page.locator('.lane-name').allTextContents(), [
    'Agent current-work',
    'Agent message-only',
    'Agent old-work',
    'Agent old-done'
  ])
  await page.keyboard.press('Home')
  assert.deepEqual(await page.locator('.lane-name').allTextContents(), ['Agent current-work'])
  assert.deepEqual(errors, [])
  await page.close()
})
