import { runProcess } from '@orca/process-host'
import { terminalCliSpec } from './terminal-cli-policy.mjs'

export async function runTerminalCli(args) {
  const result = await runProcess(terminalCliSpec(args, process.argv[1], process.execPath))
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
