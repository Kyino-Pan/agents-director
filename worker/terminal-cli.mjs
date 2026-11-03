import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'

export async function runTerminalCli(args) {
  const entry = resolve(dirname(process.argv[1] || ''), '..', 'cli', 'index.js')
  let program = process.platform === 'linux' ? 'orca-ide' : 'orca'
  let prefix = []
  try {
    await access(entry)
    program = process.execPath
    prefix = [entry]
  } catch {
    if (process.platform === 'win32') {
      throw new Error('Terminal navigation requires the Orca desktop plugin worker.')
    }
  }
  const result = await runProcess({
    program,
    args: [...prefix, 'terminal', ...args, '--json'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 8000,
    maxOutputBytes: 256 * 1024
  })
  if (result.timedOut) {
    throw new Error('Terminal navigation timed out. Try again.')
  }
  let reply
  try {
    reply = JSON.parse(result.stdout)
  } catch {
    throw new Error('The Orca CLI did not return a terminal result.')
  }
  if (!reply.ok) {
    const stale =
      reply.error?.code === 'terminal_handle_stale' ||
      reply.error?.message === 'terminal_handle_stale'
    throw Object.assign(
      new Error(
        stale
          ? 'This terminal address has expired. The terminal may have closed or Orca restarted.'
          : reply.error?.message || 'The terminal is no longer available.'
      ),
      { code: stale ? 'terminal_handle_stale' : reply.error?.code }
    )
  }
  return reply.result
}
