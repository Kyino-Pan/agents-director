import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pageFor } from './panel-test-browser.mjs'
import { snapshot } from './panel.fixture.mjs'
import { resolveLocale } from './panel-i18n.mjs'

const manifest = JSON.parse(await readFile(new URL('orca-plugin.json', import.meta.url)))
const tags = ['zh-Hans-CN', 'ja-JP', 'ko-KR', 'en-GB', 'fr-CA', 'de-AT']
const catalogs = new Map()
for (const tag of tags) {
  const lang = new Intl.Locale(tag).language
  catalogs.set(lang, lang === 'en' ? {} : (await import('./locales/' + lang + '.mjs')).default)
}
const lookup = (lang, key) => catalogs.get(lang)[key] ?? key

test('locale negotiation handles missing, malformed, unsupported and regional preferences', () => {
  assert.equal(resolveLocale('ja-JP', ['de']), 'ja-JP')
  assert.equal(resolveLocale(null, ['it-IT', 'zh-Hant-TW']), 'zh-Hant-TW')
  assert.equal(resolveLocale('invalid_locale', ['fr-CA']), 'fr-CA')
  assert.equal(resolveLocale('es-ES', ['de']), 'en')
  for (const [lang, catalog] of catalogs) {
    if (lang === 'en') continue
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(catalogs.get('zh')).sort())
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value.trim(), lang + ': ' + key)
      assert.deepEqual(
        value.match(/\{\w+\}/g)?.sort(),
        key.match(/\{\w+\}/g)?.sort(),
        lang + ': ' + key
      )
    }
  }
})

for (const [index, tag] of tags.entries()) {
  test('panel and editor controls, messages and source details follow ' + tag, async () => {
    const lang = new Intl.Locale(tag).language
    const tr = (key) => lookup(lang, key)
    const data = structuredClone(snapshot)
    const message = data.messages[0]
    message.type = 'Mailbox received'
    message.subject = 'Done' // A verbatim title can happen to be a translated UI key.
    data.agents[0].label = 'Working'
    data.sources = [
      {
        name: 'Agents · space:01',
        status: 'ok',
        detail: 'Work: Studio: current agents read through the public API.'
      }
    ]
    const { page, errors } = await pageFor({
      hostLocale: tag,
      browserLocale: 'it-IT',
      data,
      width: 320,
      height: 800,
      dark: index % 2 === 1
    })
    try {
      await page.waitForFunction(
        (version) => document.getElementById('plugin-version').textContent === 'v' + version,
        manifest.version
      )
      await page.locator('.lane').first().waitFor()
      for (const width of [320, 960]) {
        await page.setViewportSize({ width, height: 800 })
        assert.equal(await page.locator('html').getAttribute('lang'), tag)
        assert.equal(await page.locator('#shorten-links').innerText(), tr('Group related lanes'))
        assert.equal(
          await page.locator('#shorten-links').getAttribute('title'),
          tr('Place lanes connected by messages or spawns closer together.')
        )
        assert.equal(await page.locator('#language').inputValue(), 'auto')
        assert.equal(
          await page.getByRole('combobox', { name: tr('Language'), exact: true }).count(),
          1
        )
        assert.equal(
          (await page.locator('.legend > span').allTextContents())
            .map((s) => s.trim())
            .includes(tr('Unobserved')),
          true
        )
        assert.equal(await page.locator('pattern#unobserved-hatch rect').count(), 1)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        const readable = await page.evaluate(() =>
          [
            '.heading h1',
            '#live-status',
            '#language',
            '#shorten-links',
            '#hide-short-tasks',
            '#pause'
          ].every((selector) => {
            const el = document.querySelector(selector),
              box = el.getBoundingClientRect()
            return (
              box.left >= 0 &&
              box.right <= innerWidth &&
              box.height >= 12 &&
              el.scrollWidth <= el.clientWidth + 1
            )
          })
        )
        assert.ok(readable, 'controls fit ' + tag + ' at ' + width)
        const status = await page.locator('#live-status').boundingBox()
        const language = await page.locator('#language').boundingBox()
        assert.ok(Math.abs(status.y + status.height / 2 - (language.y + language.height / 2)) < 2)

        if (lang === 'zh' && process.env.ACTIVITY_SCREENSHOTS) {
          await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
          await page.screenshot({
            path: join(process.env.ACTIVITY_SCREENSHOTS, 'zh-panel-' + width + '.png')
          })
        }
      }
      for (const [kind, name] of [
        ['project', 'Orca'],
        ['terminal', 'Working']
      ]) {
        const label = tr('Pin ' + kind + ' {name}').replace('{name}', name)
        const pin = page.getByRole('button', { name: label, exact: true })
        const unpin = page.getByRole('button', {
          name: tr('Pinned') + ' · ' + tr('Unpin ' + kind + ' {name}').replace('{name}', name),
          exact: true
        })
        await pin.click()
        await unpin.waitFor()
        assert.equal(await unpin.getAttribute('aria-pressed'), 'true')
        await unpin.click()
        await pin.waitFor()
      }
      assert.equal(
        await page.locator('.lane-name').getByText('Working', { exact: true }).count(),
        1
      )
      await page.locator('[data-message="m1"]').dispatchEvent('click')
      assert.equal(await page.locator('#detail-heading').innerText(), 'Done')
      assert.ok((await page.locator('#detail-meta').innerText()).includes(tr('Mailbox received')))
      assert.ok((await page.locator('#detail-body').innerText()).includes(message.body))
      assert.ok((await page.locator('#identity-list').innerText()).includes(tr('Agent ID')))
      await page.locator('#close-detail').click()
      await page.locator('.lane').first().click({ button: 'right' })
      await page.locator('#show-sources').click()
      assert.equal(await page.locator('.source-state').textContent(), tr('ok'))
      const detail = await page.locator('.source p').innerText()
      assert.equal(
        detail,
        tr('{workspace}: current agents read through the public API.').replace(
          '{workspace}',
          'Work: Studio'
        )
      )
      await page.locator('#close-sources').click()
      await page.evaluate(() => {
        window.testFail = true
        window.notifyActivity()
      })
      await page.locator('#failure').waitFor()
      assert.ok(
        (await page.locator('#failure-text').innerText()).includes(tr('Worker unavailable'))
      )
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  })
}

test('manual language survives reopen and preserves a paused time window, search and selection', async () => {
  const preferences = new Map()
  const { page, errors } = await pageFor({ hostLocale: 'ja-JP', preferences })
  try {
    await page.locator('.zoom-tick[data-hours="6"]').click()
    await page.locator('#search').fill('Coordinator')
    await page.locator('#pause').click()
    await page.locator('.lane').click()
    const range = await page.locator('#range-end').inputValue()
    await page.locator('#language').selectOption('fr')
    await page.waitForFunction(() => document.documentElement.lang === 'fr')
    assert.equal(await page.locator('html').getAttribute('lang'), 'fr')
    assert.equal(await page.locator('#live-status').innerText(), 'Vue suspendue')
    assert.equal(await page.locator('#pause').innerText(), 'Reprendre le direct')
    assert.equal(await page.locator('#detail-heading').innerText(), 'Coordinator')
    assert.equal(await page.locator('#range-end').inputValue(), range)
    assert.equal(await page.locator('#search').inputValue(), 'Coordinator')
    await page.evaluate(() => {
      window.orca.locale = 'ko-KR'
      window.notifyActivity()
    })
    await page.waitForFunction(() => window.snapshotRequests.length >= 2)
    assert.equal(await page.locator('html').getAttribute('lang'), 'fr')
    await page.waitForFunction(
      async () => (await window.orca.storage.get('view:language')) === 'fr'
    )
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
  const { page: reopened } = await pageFor({ hostLocale: 'de-AT', preferences, width: 320 })
  try {
    assert.equal(await reopened.locator('#language').inputValue(), 'fr')
    await reopened.locator('#language').selectOption('auto')
    await reopened.waitForFunction(() => document.documentElement.lang === 'de-AT')
    assert.equal(await reopened.locator('html').getAttribute('lang'), 'de-AT')
    await reopened.evaluate(() => {
      window.orca.locale = 'ja-JP'
      window.notifyActivity()
    })
    await reopened.waitForFunction(() => document.documentElement.lang === 'ja-JP')
  } finally {
    await reopened.close()
  }
})

test('background refreshes keep the live label and language control in place', async () => {
  for (const width of [320, 960]) {
    const { page } = await pageFor({ width, hostLocale: 'zh-CN' })
    try {
      await page.locator('#live-status[data-state="live"]').waitFor()
      const live = await page.locator('#live-status').innerText()
      const language = page.locator('#language')
      const before = await language.boundingBox()
      const during = await page.evaluate(() => {
        const status = document.getElementById('live-status')
        window.liveMutations = 0
        new MutationObserver((records) => {
          window.liveMutations += records.length
        }).observe(status, {
          attributes: true,
          childList: true,
          subtree: true,
          characterData: true
        })
        window.notifyActivity()
        window.notifyActivity()
        return status.textContent
      })
      assert.equal(during, live)
      await page.waitForFunction(
        () => window.snapshotRequests.length >= 3 && !document.getElementById('retry').disabled
      )
      assert.equal(await page.evaluate(() => window.liveMutations), 0)
      assert.deepEqual(await language.boundingBox(), before)

      await page.evaluate(() => {
        window.testFail = true
        window.notifyActivity()
      })
      await page.locator('#live-status[data-state="error"]').waitFor()
      await page.evaluate(() => {
        window.testFail = false
      })
      await page.locator('#retry').click()
      await page.locator('#live-status[data-state="live"]').waitFor()
      assert.equal(await page.locator('#live-status').innerText(), live)
    } finally {
      await page.close()
    }
  }
})

test('updating and paused status stay readable; missing host falls back to browser then English', async () => {
  for (const [hostLocale, browserLocale, lang] of [
    [null, 'fr-CA', 'fr'],
    ['?', 'it-IT', 'en']
  ]) {
    let finish
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    const { page } = await pageFor({
      width: 320,
      hostLocale,
      browserLocale,
      getSnapshot: () => pending
    })
    try {
      assert.equal(await page.locator('#live-status').innerText(), lookup(lang, 'Updating…'))
      await page.locator('#pause').click()
      finish(snapshot)
      await page.locator('.lane').first().waitFor()
      assert.equal(await page.locator('#live-status').innerText(), lookup(lang, 'View paused'))
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    } finally {
      finish(snapshot)
      await page.close()
    }
  }
})
