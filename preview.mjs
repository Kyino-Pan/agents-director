import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { RecentInputs } from './worker/recent-inputs.mjs'
import { ActivityStore } from './worker/activity-store.mjs'
import { OrcaLogReader, defaultDataDirectory } from './worker/orca-log-reader.mjs'

// A loopback preview lets older Orca builds show the real log-backed view before they gain plugin API 1.2.
export async function startPreview({ directories = [defaultDataDirectory()], port = 0 } = {}) {
  const store = new ActivityStore()
  const reader = new OrcaLogReader(store, directories)
  const recentInputs = new RecentInputs(reader)
  const root = `/${randomUUID()}/`
  let scan = Promise.resolve()
  let closing = false
  const refresh = () => {
    scan = scan
      .catch(() => {})
      .then(async () => {
        if (closing) {
          return
        }
        await reader.scan()
        store.prune()
        store.source(
          'Preview mode',
          'limited',
          'Reads source logs every 5 seconds. Direct live plugin events require Orca >=1.4.246.'
        )
      })
    return scan
  }
  await refresh()
  const assets = {
    '': ['panel.html', 'text/html; charset=utf-8'],
    'panel.css': ['panel.css', 'text/css; charset=utf-8'],
    'panel.mjs': ['panel.mjs', 'text/javascript; charset=utf-8'],
    'panel-inputs.mjs': ['panel-inputs.mjs', 'text/javascript; charset=utf-8'],
    'panel-identity.mjs': ['panel-identity.mjs', 'text/javascript; charset=utf-8'],
    'panel-harness.mjs': ['panel-harness.mjs', 'text/javascript; charset=utf-8'],
    'assets/orca-harness-icons.mjs': [
      'assets/orca-harness-icons.mjs',
      'text/javascript; charset=utf-8'
    ],
    'panel-actions.mjs': ['panel-actions.mjs', 'text/javascript; charset=utf-8'],
    'lane-order.mjs': ['lane-order.mjs', 'text/javascript'],
    'lane-motion.mjs': ['lane-motion.mjs', 'text/javascript'],
    'view-preferences.mjs': ['view-preferences.mjs', 'text/javascript']
  }
  const themeSource = await readFile(new URL('./assets/preview-theme.css', import.meta.url), 'utf8')
  const themeNames = [
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
    'radius',
    'destructive',
    'destructive-foreground'
  ]
  const themeBlock = (block) =>
    themeNames
      .map((name) => {
        const value = [...block.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].at(-1)?.[1]
        return value ? `--orca-${name}:${value.replaceAll('var(--', 'var(--orca-')};` : ''
      })
      .join('')
  const blocks = (selector) =>
    [
      ...themeSource.matchAll(
        new RegExp(`(?:^|\\n)${selector}\\s*(?:,[^{]*)?\\{([\\s\\S]*?)\\n\\}`, 'g')
      )
    ]
      .map((match) => match[1])
      .join('\n')
  const theme = `html:root{color-scheme:light;${themeBlock(blocks(':root'))}}
    @media(prefers-color-scheme:dark){html:root{color-scheme:dark;${themeBlock(blocks('\\.dark'))}}}`
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    const expectedHost = `127.0.0.1:${server.address().port}`
    if (
      request.method !== 'GET' ||
      request.headers.host !== expectedHost ||
      !request.url?.startsWith(root)
    ) {
      response.writeHead(404).end()
      return
    }
    const requestUrl = new URL(request.url, `http://${expectedHost}`)
    const route = requestUrl.pathname.slice(root.length)
    try {
      if (route === 'inputs') {
        await scan
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(
          JSON.stringify(
            await recentInputs.read({ agentId: requestUrl.searchParams.get('agentId') })
          )
        )
        return
      }
      if (route === 'snapshot') {
        await scan
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(
          JSON.stringify(
            store.snapshot(Date.now(), {
              hideShortTasks: requestUrl.searchParams.get('hideShortTasks') !== 'false'
            })
          )
        )
        return
      }
      if (route === 'bridge.mjs') {
        response.setHeader('content-type', 'text/javascript; charset=utf-8')
        response.end(`window.orca={locale:navigator.language,plugin:{request:async(name,input)=>{
          if(name==='activity.navigate')throw new Error('Open Agents Director inside Orca to navigate to a terminal.');
          if(name==='activity.inputs'){const r=await fetch('./inputs?agentId='+encodeURIComponent(input?.agentId||''));if(!r.ok)throw new Error('Inputs unavailable');return r.json();}
          if(name!=='activity.snapshot')throw new Error('Unknown preview request');
          const response=await fetch('./snapshot?hideShortTasks='+String(input?.hideShortTasks!==false));if(!response.ok)throw new Error('Collector unavailable');
          return response.json();},on:()=>({dispose(){}})}};`)
        return
      }
      const asset = assets[route]
      if (!asset) {
        response.writeHead(404).end()
        return
      }
      let content = await readFile(new URL(asset[0], import.meta.url), 'utf8')
      if (!route) {
        content = content.replace(
          '<head>',
          `<head><style>${theme}</style><script type="module" src="./bridge.mjs"></script>`
        )
      }
      response.setHeader('content-type', asset[1])
      response.end(content)
    } catch {
      response.writeHead(503).end('Activity source unavailable')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const timer = setInterval(() => void refresh().catch(() => {}), 5000)
  return {
    url: `http://127.0.0.1:${server.address().port}${root}`,
    async close() {
      closing = true
      clearInterval(timer)
      await scan
      reader.close()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directories = []
  let port = 0
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === '--data-dir' && process.argv[index + 1]) {
      directories.push(process.argv[++index])
    } else if (process.argv[index] === '--port' && process.argv[index + 1]) {
      port = Number(process.argv[++index])
    } else {
      throw new Error(
        'Usage: node preview.mjs [--data-dir <absolute Orca data path>] [--port <port>]'
      )
    }
  }
  const preview = await startPreview({ ...(directories.length ? { directories } : {}), port })
  console.log(preview.url)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void preview.close())
  }
}
