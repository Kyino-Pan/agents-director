import { lstat, realpath } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export function runtimeEndpoint(metadata, directory, platform = process.platform) {
  if (
    !Number.isSafeInteger(metadata?.pid) ||
    metadata.pid <= 0 ||
    typeof metadata.runtimeId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(metadata.runtimeId) ||
    typeof metadata.authToken !== 'string' ||
    metadata.authToken.length < 16 ||
    metadata.authToken.length > 512
  ) {
    throw new Error('Invalid Orca runtime identity.')
  }
  const kind = platform === 'win32' ? 'named-pipe' : 'unix'
  const suffix = metadata.runtimeId.slice(0, 4)
  const expected =
    platform === 'win32'
      ? `\\\\.\\pipe\\orca-${metadata.pid}-${suffix}`
      : join(directory, `o-${metadata.pid}-${suffix}.sock`)
  const transports = metadata.transports ?? [metadata.transport]
  if (
    !Array.isArray(transports) ||
    !transports.some(
      (entry) =>
        entry?.kind === kind && typeof entry.endpoint === 'string' && entry.endpoint === expected
    )
  ) {
    throw new Error('Orca navigation requires its local runtime socket.')
  }
  return expected
}

export async function validateRuntimeSocket(endpoint, directory) {
  if (process.platform === 'win32') return
  const [socket, parent, canonicalParent, canonicalDirectory] = await Promise.all([
    lstat(endpoint),
    lstat(dirname(endpoint)),
    realpath(dirname(endpoint)),
    realpath(directory)
  ])
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o022) !== 0 ||
    (socket.mode & 0o022) !== 0 ||
    canonicalParent !== canonicalDirectory
  ) {
    throw new Error('Orca runtime socket ownership or permissions are unsafe.')
  }
}
