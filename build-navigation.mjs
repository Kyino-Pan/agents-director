import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

await build({
  entryPoints: [fileURLToPath(new URL('worker/terminal-cli.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('dist/terminal-cli.mjs', import.meta.url)),
  alias: {
    '@orca/process-host': fileURLToPath(
      new URL('./vendor/process-host/run-process.ts', import.meta.url)
    )
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22'
})
