import { basename, dirname, isAbsolute, resolve, join } from 'node:path'
import { sourceFilePath } from './source-files.mjs'

export function terminalCliSpec(
  args,
  workerEntry,
  executable,
  environment = process.env,
  platform = process.platform
) {
  if (
    !Array.isArray(args) ||
    args.length !== 3 ||
    !['show', 'switch', 'list'].includes(args[0]) ||
    args[1] !== (args[0] === 'list' ? '--worktree' : '--terminal') ||
    typeof args[2] !== 'string' ||
    args[2].length > 2048 ||
    [...args[2]].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    !(args[0] === 'list' ? /^id:.+/.test(args[2]) : /^term_[a-zA-Z0-9_-]+$/.test(args[2]))
  ) {
    throw new Error('Unsupported terminal navigation arguments.')
  }
  if (
    !workerEntry ||
    !isAbsolute(workerEntry) ||
    basename(workerEntry) !== 'plugin-host-entry.js' ||
    !isAbsolute(executable)
  ) {
    throw new Error('Terminal navigation requires the Orca desktop plugin worker.')
  }
  const root = resolve(dirname(workerEntry), '..')
  const entry = sourceFilePath(join(root, 'cli', 'index.js'), [root])
  const allowed = new Set([
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR'
  ])
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        typeof value === 'string' && allowed.has(platform === 'win32' ? key.toUpperCase() : key)
    )
  )
  if (
    platform === 'win32' &&
    !Object.keys(env).some((key) => key.toUpperCase() === 'APPDATA') &&
    env.USERPROFILE
  ) {
    env.APPDATA = join(env.USERPROFILE, 'AppData', 'Roaming')
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  return {
    program: executable,
    args: [entry, 'terminal', ...args, '--json'],
    env,
    timeoutMs: 8000,
    maxOutputBytes: 256 * 1024
  }
}
