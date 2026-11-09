import { constants, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

export function sourceFilePath(path, roots) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('Source path must be an absolute local file path.')
  }
  const canonical = realpathSync(path)
  const contained = roots.some((root) => {
    try {
      const rest = relative(realpathSync(root), canonical)
      return (
        rest !== '' &&
        rest !== '..' &&
        !rest.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(rest)
      )
    } catch {
      return false
    }
  })
  if (!contained) throw new Error('Source file is outside the permitted data directories.')
  if (!statSync(canonical).isFile()) throw new Error('Source must be a regular file.')
  return canonical
}

export async function openSourceFile(path, roots, { privateFile = false } = {}) {
  const canonical = sourceFilePath(path, roots)
  const file = await open(
    canonical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const info = await file.stat()
    const current = statSync(sourceFilePath(path, roots))
    if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino) {
      throw new Error('Source file changed while opening it.')
    }
    if (
      privateFile &&
      process.platform !== 'win32' &&
      (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    ) {
      throw new Error('Orca runtime credentials must be private to the current user.')
    }
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

export async function readSourceText(path, roots, limit, options) {
  const file = await openSourceFile(path, roots, options)
  try {
    const { size } = await file.stat()
    if (size > limit) throw new Error('Source exceeds the bounded reader limit.')
    const bytes = Buffer.alloc(Math.min(size + 1, limit + 1))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > limit) throw new Error('Source exceeds the bounded reader limit.')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}
