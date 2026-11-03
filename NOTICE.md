# Attribution

MIT-licensed software derived from the Agent Activity plugin in Orca,
https://github.com/stablyai/orca, with subsequent development by Kyino-Pan.
The original MIT notice is preserved in LICENSE. This is a community plugin, not an official Orca product.

The vendored process launcher in `vendor/process-host/` and preview theme variables in
`assets/preview-theme.css` were copied from the local Orca checkout at
`35beff1ef23ec525b6ae29f02a5a16907ca2fd17`, from these source paths:

- `src/packages/process-host/src/` (the transitive dependencies of `run-process.ts`)
- `src/renderer/src/assets/main.css` (selected light/dark theme variables)

`dist/terminal-cli.mjs` is an unminified bundle produced by `npm run build`. The complete
source used by that build is included in this repository. No runtime download is required.
