import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageFor } from './panel-test-browser.mjs'
import { ActivityStore } from './worker/activity-store.mjs'
import { terminalKey } from './pin-identity.mjs'

const now = Date.UTC(2026, 8, 1, 12)
const start = now - 300000
function fixture() {
  const store = new ActivityStore(start - 600000)
  for (const [id, host, project, at] of [
    ['active-a', 'h1', 'p', now - 100000],
    ['quiet-a', 'h1', 'p', start - 300000],
    ['active-b', 'h2', 'p', now - 100000],
    ['quiet-b', 'h2', 'p', start - 300000],
    ['quiet-c', 'h3', 'c', start - 300000]
  ]) {
    store.agent(id, {
      hostId: host,
      projectId: project,
      projectName: 'Shared name',
      workspace: host,
      provider: 'codex',
      terminalHandle: id,
      sessionId: 'session-' + id,
      label: id.startsWith('quiet') ? 'Same lane' : id
    })
    store.point(id + 'work', id, at, 'working', 'live', at + 30000)
  }
  store.message({
    id: 'cross',
    from: 'active-a',
    to: 'active-b',
    at: now - 30000,
    type: 'Send accepted'
  })
  return store
}

test('pinned projects and terminals stay scoped, searchable and keyboard accessible on reopen', async () => {
  const store = fixture()
  const preferences = new Map()
  const options = {
    width: 360,
    height: 800,
    preferences,
    getSnapshot: (input) => store.snapshot(now, input)
  }
  async function lanes(page) {
    return page.locator('.lane').evaluateAll((items) => items.map((el) => el.dataset.agent))
  }
  const first = await pageFor(options)
  try {
    const { page } = first
    const quiet = page.locator('.lane-row').filter({ has: page.locator('[data-agent="quiet-b"]') })
    const pin = quiet.locator('.pin-control')
    await pin.focus()
    await page.keyboard.press('Enter')
    await page.locator('.lane-row:has([data-agent="quiet-b"]) [aria-pressed="true"]').waitFor()
    assert.match(await pin.getAttribute('aria-label'), /Pinned · Unpin terminal/)
    assert.equal(await pin.evaluate((el) => el === document.activeElement), true)
    const project = quiet
      .locator('xpath=preceding-sibling::div[contains(@class,"project-row")][1]')
      .locator('button')
    await project.click()
    await page.locator('.project-row [aria-pressed="true"]').waitFor()
    assert.deepEqual((await lanes(page)).slice(0, 2), ['quiet-b', 'active-b'])
    const other = page.locator('.lane-row').filter({ has: page.locator('[data-agent="quiet-c"]') })
    await other
      .locator('xpath=preceding-sibling::div[contains(@class,"project-row")][1]')
      .locator('button')
      .click()
    await page.waitForFunction(
      () => document.querySelectorAll('.project-row [aria-pressed=true]').length === 2
    )
    await page.locator('#zoom').focus()
    await page.keyboard.press('Home')
    await page.locator('.lane[data-agent="quiet-a"]').waitFor({ state: 'detached' })
    assert.deepEqual(await lanes(page), ['quiet-b', 'active-b', 'active-a'])
    assert.equal(await page.locator('.project-row').count(), 3)
    assert.equal(await quiet.locator('.lane-state').innerText(), 'No activity in this window')
    await quiet.locator('.lane').click()
    assert.match(
      await page.locator('#detail-body').innerText(),
      /pinned terminal has no recorded activity/
    )
    await page.locator('#close-detail').click()
    await page.locator('#shorten-links').click()
    assert.equal(await page.locator('[data-message="cross"]').getAttribute('data-from'), 'active-a')
    assert.equal(await page.locator('[data-message="cross"]').getAttribute('data-to'), 'active-b')
    await page.locator('#search').fill('active-a')
    assert.deepEqual(await lanes(page), ['active-a'])
    assert.equal(
      await page.locator('.message-target,.project-row button[aria-pressed=true]').count(),
      0
    )
    await page.waitForFunction(
      async () =>
        (await window.orca.storage.get('view:pinned-projects'))?.length === 2 &&
        (await window.orca.storage.get('view:pinned-terminals'))?.length === 1
    )
  } finally {
    await first.page.close()
  }
  const reopened = await pageFor(options)
  try {
    const { page } = reopened
    await page.locator('.lane').first().waitFor()
    assert.deepEqual(await lanes(page), ['quiet-b', 'active-b', 'active-a'])
    await page.getByRole('button', { name: 'Pinned · Unpin terminal Same lane' }).click()
    await page.locator('[data-agent="quiet-b"].lane').waitFor({ state: 'detached' })
    assert.deepEqual(await lanes(page), ['active-b', 'active-a'])
    assert.equal(await page.locator('.project-row').count(), 3)
    // Unpin both same-name projects, including the heading with no active terminal.
    for (let remaining = 1; remaining >= 0; remaining--) {
      await page.getByRole('button', { name: 'Pinned · Unpin project Shared name' }).first().click()
      await page.waitForFunction(
        (n) => document.querySelectorAll('.project-row [aria-pressed=true]').length === n,
        remaining
      )
    }
    assert.equal(await page.locator('.project-row').count(), 2)
    assert.deepEqual(await lanes(page), ['active-a', 'active-b'])
    assert.deepEqual(reopened.errors, [])
  } finally {
    await reopened.page.close()
  }
})

test('only the pinned public identity is exempt from a short-task filter or snapshot lane cap', () => {
  const store = fixture()
  const pinned = store.agents.get('quiet-b')
  const key = terminalKey(pinned)
  const at = start - 250000
  store.point('short-finish', 'quiet-b', start - 270000, 'done', 'live', at)
  store.point('other-finish', 'quiet-a', start - 270000, 'done', 'live', at)
  for (let n = 0; n < 180; n++) store.point('i' + n, 'aaa' + n, start, 'working', 'live', now)
  const view = store.snapshot(now, { hideShortTasks: true, pinnedTerminals: [key] })
  assert.equal(view.agents.length, 160)
  assert.equal(view.hiddenShortTasks, 1)
  assert.equal(view.agents.find((a) => a.id === pinned.id).pinnedShortTask, true)
  assert.equal(
    view.agents.some((a) => a.id === 'quiet-a'),
    false
  )
  assert.notEqual(terminalKey({ ...pinned, sessionId: 'replacement' }), key)
  assert.notEqual(terminalKey({ ...pinned, hostId: 'another-host' }), key)
  assert.equal(
    terminalKey({ ...pinned, terminalHandle: 'resumed-terminal', label: 'renamed' }),
    key
  )
})

test('a project keeps its own unpin button with zero qualifying lanes and after the lane cap', async () => {
  const store = new ActivityStore(start - 86400000)
  const add = (id, project, at, until, state = 'working') => {
    store.agent(id, {
      label: id,
      hostId: 'h',
      projectId: project,
      projectName: project,
      sessionId: id
    })
    store.point(id + state, id, at, state, 'live', until)
  }
  add('zz-short', 'Short', now - 50000, now - 30000)
  add('zz-short', 'Short', now - 30000, now - 12000, 'done')
  const { page } = await pageFor({
    preferences: new Map([['view:hide-short-tasks', false]]),
    getSnapshot: (input) => store.snapshot(now, input)
  })
  try {
    await page.getByRole('button', { name: 'Pin project Short', exact: true }).click()
    const unpin = page.getByRole('button', { name: 'Pinned · Unpin project Short', exact: true })
    await unpin.waitFor()
    await page.locator('#hide-short-tasks').click()
    await page.locator('.lane').waitFor({ state: 'detached' })
    assert.equal(await unpin.isVisible(), true)
    await page.locator('#search').fill('no-match')
    assert.equal(await unpin.count(), 0)
    await page.locator('#search').fill('')
    await unpin.waitFor()
    await page.locator('#hide-short-tasks').click()
    await page.locator('.lane').waitFor()
    for (let i = 0; i < 160; i++) add('aa' + i, 'Other', now - 25000, now)
    await page.evaluate(() => window.notifyActivity())
    await page.waitForFunction(() => document.querySelectorAll('.lane').length === 160)
    assert.equal(await page.locator('.lane[data-agent="zz-short"]').count(), 0)
    await unpin.click()
    await unpin.waitFor({ state: 'detached' })
    assert.deepEqual(await page.locator('.project-heading').allTextContents(), ['Other'])
  } finally {
    await page.close()
  }
})

test('unselected project and terminal pins reveal only their row on hover or keyboard focus', async () => {
  const { page } = await pageFor({ getSnapshot: (input) => fixture().snapshot(now, input) })
  try {
    for (const rowClass of ['project-row', 'lane-row']) {
      const row = page.locator('.' + rowClass).first()
      const button = row.locator('.pin-control')
      const opacity = () => button.evaluate((el) => getComputedStyle(el).opacity)
      const box = () =>
        row.locator(rowClass === 'project-row' ? '.project-heading' : '.lane').boundingBox()
      await page.mouse.move(0, 0)
      await page.locator('#search').focus()
      assert.equal(await opacity(), '0')
      const before = await box()
      await row.hover()
      assert.equal(await opacity(), '1')
      assert.equal(
        await page
          .locator('.' + rowClass)
          .nth(1)
          .locator('.pin-control')
          .evaluate((el) => getComputedStyle(el).opacity),
        '0'
      )
      assert.deepEqual(await box(), before)
      await page.mouse.move(0, 0)
      assert.equal(await opacity(), '0')
      // Start immediately before this button in normal Tab order.
      await button.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      assert.equal(await button.evaluate((el) => document.activeElement === el), true)
      assert.equal(await opacity(), '1')
      await page.keyboard.press('Tab')
      assert.equal(await opacity(), '0')
      await button.click()
      await row.locator('[aria-pressed=true].pin-control').waitFor()
      await page.mouse.move(0, 0)
      await page.locator('#search').focus()
      assert.equal(await opacity(), '1')
      await button.click()
      await row.locator('[aria-pressed=false].pin-control').waitFor()
    }
  } finally {
    await page.close()
  }
})

test('two open views persist consecutive toggles and language, and keep collecting after write failure', async () => {
  class Preferences extends Map {
    set(key, value) {
      if (this.reject && key === 'view:pinned-terminals') throw new Error('storage unavailable')
      return super.set(key, value)
    }
  }
  const preferences = new Preferences()
  const data = fixture()
  const opts = { preferences, getSnapshot: (input) => data.snapshot(now, input) }
  const { page: side } = await pageFor({ ...opts, width: 350 })
  const { page: editor } = await pageFor(opts)
  const pin = (page, id) =>
    page
      .locator('.lane-row')
      .filter({ has: page.locator('.lane[data-agent="' + id + '"]') })
      .locator('.pin-control')
  const waitStar = (page, id, selected) =>
    page
      .locator('.lane-row')
      .filter({ has: page.locator('.lane[data-agent="' + id + '"]') })
      .locator('.pin-control[aria-pressed="' + selected + '"]')
      .waitFor()
  try {
    await side.locator('#pause').click()
    await side.locator('#search').fill('active')
    const range = await side.locator('#range-end').inputValue()
    await Promise.all([pin(side, 'active-a').click(), pin(editor, 'active-b').click()])
    await Promise.all([waitStar(side, 'active-b', true), waitStar(editor, 'active-a', true)])
    await pin(editor, 'active-a').click()
    await waitStar(side, 'active-a', false)
    await editor.locator('#language').selectOption('de')
    await side.waitForFunction(() => document.documentElement.lang === 'de')
    await side.locator('#language').selectOption('zh')
    await editor.waitForFunction(() => document.documentElement.lang === 'zh')
    assert.deepEqual(preferences.get('view:pinned-terminals'), [
      terminalKey(data.agents.get('active-b'))
    ])
    assert.equal(await side.locator('#pause').getAttribute('aria-pressed'), 'true')
    assert.equal(await side.locator('#search').inputValue(), 'active')
    assert.equal(await side.locator('#range-end').inputValue(), range)
    preferences.reject = true
    await pin(editor, 'active-a').click()
    await editor.locator('#preference-error').waitFor()
    assert.equal(await pin(editor, 'active-a').getAttribute('aria-pressed'), 'false')
    assert.equal(await editor.locator('#failure').isVisible(), false)
    data.agent('active-a', { label: 'Updated sample', labelSource: 'user' })
    await editor.evaluate(() => window.notifyActivity())
    await editor.locator('.lane').getByText('Updated sample').waitFor()
    assert.equal(
      await editor.evaluate(() =>
        window.snapshotRequests.every(
          (args) =>
            Object.keys(args).sort().join() === 'hideShortTasks,view,withOmittedActivity' &&
            args.withOmittedActivity === true &&
            args.view.hours > 0
        )
      ),
      true
    )
    preferences.reject = false
    await pin(editor, 'active-a').click()
    await waitStar(side, 'active-a', true)
    await editor.locator('#preference-error').waitFor({ state: 'hidden' })
  } finally {
    await side.close()
    await editor.close()
  }
})
