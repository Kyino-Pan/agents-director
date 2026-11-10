import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { pageFor } from './panel-test-browser.mjs'
import { snapshot } from './panel.fixture.mjs'

const inputs = [
  {
    id: '3',
    at: snapshot.now - 1000,
    text: 'Keep the memory value on the second line.\nGive long agent names more room.'
  },
  {
    id: '2',
    at: snapshot.now - 2000,
    text: 'Show the latest three user inputs.\nPreserve separate repeated turns.'
  },
  {
    id: '1',
    at: snapshot.now - 3000,
    text: 'Keep Agent ID and Harness visible.\nMove other identity fields into More information.'
  }
]

test('core identity, native disclosure, three multiline inputs and second-row memory fit both themes and sizes', async () => {
  await mkdir('/tmp/director-agent-details-shots', { recursive: true })
  const data = structuredClone(snapshot)
  data.agents[0].label = 'Coordinator with a long conversation name for detail inspection'
  data.agents[0].provider = 'claude'
  data.agents[0].memory = {
    bytes: 1.25 * 1024 ** 3,
    metric: 'footprint',
    collectedAt: snapshot.now
  }
  for (const width of [1280, 360])
    for (const dark of [false, true]) {
      const { page, errors } = await pageFor({
        width,
        height: width === 360 ? 640 : 820,
        dark,
        data,
        getInputs: ({ agentId }) => ({ agentId, inputs })
      })
      try {
        const lane = page.locator(`.lane[data-agent="${data.agents[0].id}"]`)
        assert.equal(await lane.locator('.lane-heading .lane-memory').count(), 0)
        assert.equal(await lane.locator('.lane-meta .lane-memory').textContent(), '1.3 GiB')
        if (width === 360)
          await page.screenshot({
            path: `/tmp/director-agent-details-shots/${width}-${dark ? 'dark' : 'light'}-lanes.png`
          })
        await lane.focus()
        await page.keyboard.press('Enter')
        await page.locator('.user-input').nth(2).waitFor()
        assert.deepEqual(await page.locator('#identity-list dt').allTextContents(), [
          'Agent ID',
          'Harness'
        ])
        assert.equal(await page.locator('#identity-list dd').nth(1).textContent(), 'Claude')
        assert.equal(await page.locator('#identity').evaluate((el) => el.open), false)
        assert.equal(await page.getByRole('button', { name: 'Copy agent ID' }).isVisible(), true)
        assert.deepEqual(
          await page.locator('.user-input p').allTextContents(),
          inputs.map((i) => i.text)
        )
        assert.equal(
          await page.locator('#detail').evaluate((el) => el.scrollWidth <= el.clientWidth),
          true
        )
        await page.screenshot({
          path: `/tmp/director-agent-details-shots/${width}-${dark ? 'dark' : 'light'}.png`
        })
        await page.locator('#identity summary').focus()
        await page.keyboard.press('Enter')
        assert.equal(await page.locator('#identity').evaluate((el) => el.open), true)
        assert.match(await page.locator('#identity-more').textContent(), /session_demo_coordinator/)
        await page.keyboard.press('Escape')
        const segment = page.locator(`[data-agent="${data.agents[0].id}"][data-segment]`).first()
        await segment.focus()
        await page.keyboard.press('Enter')
        assert.equal(await page.locator('#identity').evaluate((el) => el.open), false)
        assert.deepEqual(await page.locator('#identity-list dt').allTextContents(), [
          'Agent ID',
          'Harness'
        ])
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    }
})

test('selection changes reject old input replies, including A → B → A and same ID with new provider session', async () => {
  const pending = []
  const { page, errors } = await pageFor({
    getInputs: (request) => new Promise((resolve) => pending.push({ ...request, resolve }))
  })
  const pick = async (index) => {
    await page
      .locator('#close-detail')
      .click()
      .catch(() => {})
    await page.locator(`.lane[data-agent="${snapshot.agents[index].id}"]`).click()
  }
  const waitRequests = async (n) => {
    await page.waitForFunction((n) => window.inputCalls >= n, n)
  }
  // Count requests in the browser to avoid sleep-based synchronization.
  await page.evaluate(() => {
    const original = window.orca.plugin.request
    window.inputCalls = 0
    window.inputReplies = 0
    window.orca.plugin.request = (name, input) => {
      if (name === 'activity.inputs') window.inputCalls++
      return original(name, input).then((result) => {
        if (name === 'activity.inputs') window.inputReplies++
        return result
      })
    }
  })
  await page.locator('.lane').first().click()
  await waitRequests(1)
  await pick(1)
  await waitRequests(2)
  pending[1].resolve({ agentId: pending[1].agentId, inputs: [{ ...inputs[0], text: 'B only' }] })
  await page.getByText('B only', { exact: true }).waitFor()
  await pick(0)
  await waitRequests(3)
  pending[2].resolve({ agentId: pending[2].agentId, inputs: [{ ...inputs[0], text: 'fresh A' }] })
  await page.getByText('fresh A', { exact: true }).waitFor()
  pending[0].resolve({
    agentId: pending[0].agentId,
    inputs: [{ ...inputs[0], text: 'stale A' }]
  })
  await page.waitForFunction(() => window.inputReplies === 3)
  assert.equal(await page.getByText('fresh A', { exact: true }).count(), 1)
  await page.evaluate(() => {
    window.testSnapshot.agents[0].providerSessionId = 'new-conversation'
    window.notifyActivity()
  })
  await waitRequests(4)
  assert.equal(await page.getByText('fresh A', { exact: true }).count(), 0)
  pending[3].resolve({ agentId: pending[3].agentId, inputs: [] })
  await page.getByText('No recorded user inputs.', { exact: true }).waitFor()
  assert.equal(await page.getByText('stale A', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  await page.close()
})

test('long literal text wraps, truncation is labelled, refresh preserves DOM/focus/scroll and message body stays separate', async () => {
  let calls = 0
  const long = {
    id: 'long',
    at: snapshot.now,
    text: '<img src=x onerror=alert(1)>\n' + 'x'.repeat(3900),
    truncated: true
  }
  const { page, errors } = await pageFor({
    width: 360,
    height: 640,
    getInputs: ({ agentId }) => {
      calls++
      return { agentId, inputs: [long, ...inputs.slice(0, 2)] }
    }
  })
  await page.locator('.lane').first().click()
  await page.getByText('Text truncated', { exact: true }).waitFor()
  assert.equal(await page.locator('#recent-inputs img').count(), 0)
  assert.equal(
    await page.locator('#detail').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true
  )
  await page.evaluate(() => {
    window.savedInput = document.querySelector('.user-input')
    document.getElementById('detail').scrollTop = 200
    window.notifyActivity()
  })
  await page.waitForFunction(() => window.snapshotRequests.length >= 2)
  assert.equal(
    await page.evaluate(() => window.savedInput === document.querySelector('.user-input')),
    true
  )
  assert.equal(await page.locator('#detail').evaluate((el) => el.scrollTop), 200)
  // Advance the controller's refresh clock without a real five-second sleep.
  await page.evaluate(() => {
    const now = Date.now
    Date.now = () => now() + 5000
    window.notifyActivity()
  })
  await page.waitForFunction(() => window.snapshotRequests.length >= 3)
  await page.waitForFunction(() => window.savedInput === document.querySelector('.user-input'))
  assert.equal(await page.locator('#detail').evaluate((el) => el.scrollTop), 200)
  await page.locator('#close-detail').click()
  await page.locator('[data-message="m7"]').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#recent-inputs').isHidden(), true)
  assert.match(await page.locator('#detail-body').textContent(), /literal message text/)
  assert.ok(calls >= 2)
  assert.deepEqual(errors, [])
  await page.close()
})

test('unavailable source is explicit and does not replace identity or coordination information', async () => {
  const { page, errors } = await pageFor({
    getInputs: () => {
      throw new Error('missing source')
    }
  })
  await page.locator('.lane').first().click()
  await page.getByText('Recent user inputs unavailable.', { exact: true }).waitFor()
  assert.equal(await page.locator('#identity-list dd').first().textContent(), snapshot.agents[0].id)
  assert.deepEqual(errors, [])
  await page.close()
})
