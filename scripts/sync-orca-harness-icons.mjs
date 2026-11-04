import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

const root = process.argv[2]
if (!root) {
  throw new Error('Usage: node scripts/sync-orca-harness-icons.mjs <Orca checkout>')
}
const source = resolve(root)
const require = createRequire(import.meta.url)
const stubs = {
  '@/i18n/i18n': 'export const translate = (_key, fallback) => fallback',
  '@/i18n/localized-catalog': 'export const createLocalizedCatalog = (build) => build',
  './agent-catalog-platform': 'export const getCatalogPlatform = () => "darwin"',
  '../../../shared/tui-agent-config':
    'export const TUI_AGENT_CONFIG = {}; export const getTuiAgentLaunchCommand = () => ""'
}
const result = await build({
  stdin: {
    contents: `export { AgentIcon, getAgentCatalog, getAgentLabel } from ${JSON.stringify(join(source, 'src/renderer/src/lib/agent-catalog.tsx'))};
      export { runProcess } from ${JSON.stringify(fileURLToPath(new URL('../vendor/process-host/run-process.ts', import.meta.url)))};`,
    resolveDir: source
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  plugins: [
    {
      name: 'offline-catalog',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (Object.hasOwn(stubs, args.path)) {
            return { path: args.path, namespace: 'catalog-defaults' }
          }
          if (args.path === 'react' || args.path.startsWith('react/')) {
            return { path: pathToFileURL(require.resolve(args.path)).href, external: true }
          }
          if (args.path.endsWith('?url')) {
            return { path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'image' }
          }
          if (args.path.startsWith('@/')) {
            return { path: join(source, 'src/renderer/src', `${args.path.slice(2)}.tsx`) }
          }
        })
        build.onLoad({ filter: /.*/, namespace: 'catalog-defaults' }, (args) => ({
          contents: stubs[args.path]
        }))
        build.onLoad({ filter: /.*/, namespace: 'image' }, async (args) => {
          const type = args.path.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
          const url = `data:${type};base64,${(await readFile(args.path)).toString('base64')}`
          return { contents: `export default ${JSON.stringify(url)}` }
        })
      }
    }
  ]
})
const { AgentIcon, getAgentCatalog, getAgentLabel, runProcess } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)
const revision = await runProcess({ program: 'git', args: ['-C', source, 'rev-parse', 'HEAD'] })
if (revision.code !== 0) {
  throw new Error('Cannot resolve the Orca source revision')
}
const commit = revision.stdout.trim()
const supported = await readFile(join(source, 'src/shared/agent-type-icon-agent.ts'), 'utf8')
const ids = [...supported.matchAll(/^  (?:'([^']+)'|(\w+)): true,?$/gm)].map((m) => m[1] ?? m[2])
const catalog = new Map(getAgentCatalog().map((entry) => [entry.id, entry]))
const icons = {}
for (const id of ids) {
  const markup = renderToStaticMarkup(createElement(AgentIcon, { agent: id, size: 14 })).replace(
    /<link\b[^>]*\/>/g,
    ''
  )
  if (/https?:\/\//.test(markup.replace('http://www.w3.org/2000/svg', ''))) {
    throw new Error(`Icon ${id} requires a network fetch`)
  }
  icons[id] = { label: catalog.get(id)?.label ?? getAgentLabel(id), markup }
}
if (!icons.codex || !icons.claude || !icons.grok || ids.length < 3) {
  throw new Error('Orca catalog format changed; inspect before regenerating')
}
const output = new URL('../assets/orca-harness-icons.mjs', import.meta.url)
await mkdir(dirname(fileURLToPath(output)), { recursive: true })
await writeFile(
  output,
  `// Generated from stablyai/orca ${commit}; see NOTICE.md.\n` +
    `// Run: node scripts/sync-orca-harness-icons.mjs <Orca checkout>\n` +
    `export const harnessIcons = ${JSON.stringify(icons, null, 2)}\n`
)
console.log(`Copied ${ids.length} offline harness icons from ${commit}`)
