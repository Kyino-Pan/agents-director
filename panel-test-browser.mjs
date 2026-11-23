import { createOmissionReplies } from './worker/snapshot-omissions.mjs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { before, after } from 'node:test'
import { createHeadingPages } from './worker/project-headings.mjs'
import { createSharedPreferences } from './shared-preferences.mjs'
import { snapshot, fixturePreferences } from './panel.fixture.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const directory = new URL('.', import.meta.url)
export let browser
let server
let url

before(async () => {
  server = createServer(async (request, response) => {
    const files = {
      '/': ['panel.html', 'text/html'],
      '/orca-plugin.json': ['orca-plugin.json', 'application/json'],
      '/panel-i18n.mjs': ['panel-i18n.mjs', 'text/javascript'],
      '/pin-identity.mjs': ['pin-identity.mjs', 'text/javascript'],
      '/locales/fr.mjs': ['locales/fr.mjs', 'text/javascript'],
      '/locales/de.mjs': ['locales/de.mjs', 'text/javascript'],
      '/locales/ja.mjs': ['locales/ja.mjs', 'text/javascript'],
      '/locales/ko.mjs': ['locales/ko.mjs', 'text/javascript'],
      '/locales/zh.mjs': ['locales/zh.mjs', 'text/javascript'],
      '/panel.css': ['panel.css', 'text/css'],
      '/panel.mjs': ['panel.mjs', 'text/javascript'],
      '/panel-inputs.mjs': ['panel-inputs.mjs', 'text/javascript'],
      '/panel-identity.mjs': ['panel-identity.mjs', 'text/javascript'],
      '/panel-harness.mjs': ['panel-harness.mjs', 'text/javascript'],
      '/assets/orca-harness-icons.mjs': ['assets/orca-harness-icons.mjs', 'text/javascript'],
      '/navigation-identity.mjs': ['navigation-identity.mjs', 'text/javascript'],
      '/panel-actions.mjs': ['panel-actions.mjs', 'text/javascript'],
      '/lane-order.mjs': ['lane-order.mjs', 'text/javascript'],
      '/lane-motion.mjs': ['lane-motion.mjs', 'text/javascript'],
      '/timeline-evidence.mjs': ['timeline-evidence.mjs', 'text/javascript'],
      '/shared-preferences.mjs': ['shared-preferences.mjs', 'text/javascript'],
      '/view-preferences.mjs': ['view-preferences.mjs', 'text/javascript']
    }
    const entry = files[request.url]
    if (!entry) {
      response.writeHead(404).end()
      return
    }
    response.setHeader('content-type', entry[1])
    response.end(await readFile(new URL(entry[0], directory)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
})

const sharedViews = new WeakMap()

export async function pageFor({
  width = 1100,
  height = 820,
  dark = false,
  data = snapshot,
  fail = false,
  userAgent,
  hostLocale = 'en-US',
  browserLocale = 'en-US',
  preferences = new Map(),
  getSnapshot,
  getInputs
} = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    locale: browserLocale,
    timezoneId: 'Asia/Shanghai',
    colorScheme: dark ? 'light' : 'dark',
    userAgent
  })
  await page.exposeFunction('readViewPreference', (key) => preferences.get(key) ?? null)
  await page.exposeFunction('writeViewPreference', (key, value) => preferences.set(key, value))
  if (!sharedViews.has(preferences)) {
    const pages = new Set()
    const shared = createSharedPreferences(
      {
        get: async (key) => preferences.get(key),
        set: async (key, value) => preferences.set(key, value)
      },
      () => {
        for (const open of pages)
          void open.evaluate(() => window.notifyActivity?.()).catch(() => {})
      }
    )
    sharedViews.set(preferences, {
      pages,
      shared,
      headings: createHeadingPages(),
      omissions: createOmissionReplies()
    })
  }
  const { pages, shared, headings, omissions } = sharedViews.get(preferences)
  pages.add(page)
  page.on('close', () => pages.delete(page))
  await page.exposeFunction('getProjectHeadings', headings.get)
  await page.exposeFunction('getOmittedActivity', (token) => omissions.take(page, token))
  await page.exposeFunction('changeViewPreference', shared.change)
  await page.exposeFunction('requestActivitySnapshot', async (input, staticSnapshot) => {
    const prefs = await shared.read()
    const data = getSnapshot
      ? await getSnapshot({
          ...input,
          pinnedTerminals: prefs.pinnedTerminals,
          pinnedProjects: prefs.pinnedProjects
        })
      : fixturePreferences(staticSnapshot, prefs)
    const { pinnedProjects = [], ...timeline } = data
    return {
      ...omissions.prepare(timeline, input.withOmittedActivity && page),
      headingVersion: headings.update(pinnedProjects),
      pinVersion: prefs.pinVersion,
      language: prefs.language
    }
  })
  if (getInputs) await page.exposeFunction('requestRecentInputs', getInputs)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(
    ({ data, fail, hostLocale }) => {
      window.snapshotRequests = []
      window.testSnapshot = data
      window.testFail = fail
      window.orca = {
        locale: hostLocale,
        storage: { get: window.readViewPreference, set: window.writeViewPreference },
        plugin: {
          request: async (name, input) => {
            if (name === 'activity.omittedActivity') return window.getOmittedActivity(input.token)
            if (name === 'activity.projectHeadings') return window.getProjectHeadings(input)
            if (name === 'activity.changePreference') return window.changeViewPreference(input)
            if (name === 'activity.inputs') {
              return window.requestRecentInputs
                ? window.requestRecentInputs(input)
                : { agentId: input.agentId, inputs: [] }
            }
            if (name === 'activity.navigate') {
              window.navigationRequest = input
              if (window.navigationError) {
                throw new Error(window.navigationError)
              }
              return { navigated: true }
            }
            if (window.testFail) {
              throw new Error('Worker unavailable')
            }
            window.snapshotRequests.push(input)
            return window.requestActivitySnapshot(input, window.testSnapshot)
          },
          on: (_event, callback) => {
            window.notifyActivity = callback
            return { dispose() {} }
          }
        }
      }
    },
    { data, fail, hostLocale }
  )
  await page.goto(url)
  const css = await readFile(new URL('./assets/preview-theme.css', directory), 'utf8')
  const blocks = [css.match(/:root \{([\s\S]*?)\n\}/)[1]]
  if (dark) {
    blocks.push(css.match(/\.dark \{([\s\S]*?)\n\}/)[1])
  }
  const names = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'border',
    'input',
    'ring',
    'radius'
  ]
  const vars = {}
  for (const block of blocks) {
    for (const name of names) {
      const value = block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
      if (value) {
        vars[`--orca-${name}`] = value
      }
    }
  }
  vars['--orca-destructive'] = dark ? '#ff6568' : '#e40014'
  await page.evaluate(
    ({ vars, dark }) => {
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value)
      }
      document.documentElement.classList.add(dark ? 'dark' : 'light')
    },
    { vars, dark }
  )
  await page.locator(fail ? '#failure' : '#summary').waitFor({ state: 'visible' })
  return { page, errors }
}
