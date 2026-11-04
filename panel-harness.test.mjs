import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessIcons } from './assets/orca-harness-icons.mjs'
import { pageFor } from './panel-test-browser.mjs'
import { snapshot } from './panel.fixture.mjs'

test('all Orca harness icons render offline in light and dark lanes, with distinct session identities', async () => {
  const providers = [
    'codex',
    'claude',
    'grok',
    ...Object.keys(harnessIcons).filter((id) => !['codex', 'claude', 'grok'].includes(id)),
    '__proto__'
  ]
  const data = {
    ...snapshot,
    messages: [],
    agents: providers.map((provider, index) => ({
      id: `session:${index.toString().padStart(8, '0')}`,
      label: index < 2 ? 'Same name' : undefined,
      provider,
      projectId: 'project',
      projectName: 'Harness catalog',
      workspace: 'folder:shared',
      segments: [{ start: snapshot.now - 10000, end: snapshot.now, state: 'working' }]
    }))
  }
  for (const dark of [false, true]) {
    const { page, errors } = await pageFor({ data, dark, width: 360 })
    assert.equal(await page.locator('.lane').count(), providers.length)
    for (const provider of Object.keys(harnessIcons)) {
      assert.equal(
        await page
          .locator(`[data-harness="${provider}"] svg, [data-harness="${provider}"] img`)
          .count(),
        1
      )
    }
    assert.equal(await page.locator('[data-harness="__proto__"]').textContent(), '?')
    assert.deepEqual(
      await page
        .locator('.lane-identity')
        .allTextContents()
        .then((rows) => rows.slice(0, 2)),
      ['00000000', '00000001']
    )
    await page
      .locator('.harness-icon img')
      .evaluateAll((images) => Promise.all(images.map((image) => image.decode())))
    assert.equal(
      await page
        .locator('.harness-icon img')
        .evaluateAll((images) =>
          images.every((image) => image.src.startsWith('data:') && image.naturalWidth > 0)
        ),
      true
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true
    )
    await page.locator('.lane').first().click()
    assert.equal(await page.getByText('Harness', { exact: true }).count(), 1)
    await page.keyboard.press('Escape')
    if (process.env.ACTIVITY_SCREENSHOTS) {
      await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
      await page.screenshot({
        path: join(process.env.ACTIVITY_SCREENSHOTS, `harness-${dark ? 'dark' : 'light'}.png`)
      })
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
})
