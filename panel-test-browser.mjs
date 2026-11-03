import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { before, after } from 'node:test'
import { snapshot } from './panel.fixture.mjs'

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
      '/panel.css': ['panel.css', 'text/css'],
      '/panel.mjs': ['panel.mjs', 'text/javascript'],
      '/panel-identity.mjs': ['panel-identity.mjs', 'text/javascript'],
      '/panel-actions.mjs': ['panel-actions.mjs', 'text/javascript'],
      '/lane-order.mjs': ['lane-order.mjs', 'text/javascript'],
      '/lane-motion.mjs': ['lane-motion.mjs', 'text/javascript'],
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

export async function pageFor({
  width = 1100,
  height = 820,
  dark = false,
  data = snapshot,
  fail = false,
  userAgent,
  preferences = new Map()
} = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    timezoneId: 'Asia/Shanghai',
    colorScheme: dark ? 'light' : 'dark',
    userAgent
  })
  await page.exposeFunction('readViewPreference', (key) => preferences.get(key) ?? null)
  await page.exposeFunction('writeViewPreference', (key, value) => preferences.set(key, value))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(
    ({ data, fail }) => {
      window.testSnapshot = data
      window.testFail = fail
      window.orca = {
        locale: 'en-US',
        storage: { get: window.readViewPreference, set: window.writeViewPreference },
        plugin: {
          request: async (name, input) => {
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
            return window.testSnapshot
          },
          on: (_event, callback) => {
            window.notifyActivity = callback
            return { dispose() {} }
          }
        }
      }
    },
    { data, fail }
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
