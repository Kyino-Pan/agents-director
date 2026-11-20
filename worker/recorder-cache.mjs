import { deflateSync, inflateSync } from 'node:zlib'

export const STORAGE_PREFIX = 'activity-public-v1'
const HEAD_KEY = `${STORAGE_PREFIX}:head`
const LEGACY_KEY = /^activity-v1:(?:head|[ab]:(?:0|[1-9]\d*))$/
const PUBLIC_CHUNK = /^activity-public-v1:([ab]):(0|[1-9]\d*)$/
const MAX_DECODED_BYTES = 32 * 1024 * 1024
const MAX_STORED_BYTES = 1800 * 1024

export function encodeRecorderCache(value) {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > MAX_DECODED_BYTES) {
    throw new Error('Recorder history exceeds 32 MiB; reduce source volume')
  }
  const text = deflateSync(json).toString('base64')
  if (text.length > MAX_STORED_BYTES) {
    throw new Error('Compressed recorder cache exceeds 1.8 MiB; reduce source volume')
  }
  const chunks = []
  for (let index = 0; index < text.length; index += 24000) {
    chunks.push(text.slice(index, index + 24000))
  }
  return chunks
}

export function decodeRecorderCache(head, chunks) {
  const text = chunks.join('')
  if (Buffer.byteLength(text) > MAX_STORED_BYTES) {
    throw new Error('Recorder cache exceeds the bounded reader limit')
  }
  return JSON.parse(
    head.version === 1
      ? text
      : inflateSync(Buffer.from(text, 'base64'), {
          maxOutputLength: MAX_DECODED_BYTES
        }).toString('utf8')
  )
}

export async function readRecorderInventory(storage, knownKeys = new Set()) {
  const keys = await storage.keys()
  const wasNonempty = knownKeys.size > 0
  const hadHead = knownKeys.has(HEAD_KEY)
  for (const key of keys) knownKeys.add(key)
  const head = await storage.get(HEAD_KEY)
  if (head != null) knownKeys.add(HEAD_KEY)
  if (
    (!keys.length && wasNonempty) ||
    keys.includes(HEAD_KEY) !== (head != null) ||
    (hadHead && head == null)
  ) {
    throw new Error('Public recorder storage returned inconsistent reads.')
  }
  if (head == null) return { keys, head: null }
  if (
    head.version !== 2 ||
    !['a', 'b'].includes(head.generation) ||
    !Number.isInteger(head.chunks) ||
    head.chunks < 1 ||
    head.chunks > 100
  ) {
    throw new Error('Could not read the committed public recorder head.')
  }
  return { keys, head }
}

export async function reclaimUnusedChunks(storage, { keys, head }, knownKeys) {
  for (const key of keys) {
    const chunk = PUBLIC_CHUNK.exec(key)
    if (
      LEGACY_KEY.test(key) ||
      (chunk && (chunk[1] !== head?.generation || Number(chunk[2]) >= head.chunks))
    ) {
      await storage.delete(key)
      knownKeys.delete(key)
    }
  }
}

export async function commitRecorderChunks(storage, head, chunks, knownKeys) {
  const generation = head?.generation === 'a' ? 'b' : 'a'
  try {
    for (const [index, chunk] of chunks.entries()) {
      const key = `${STORAGE_PREFIX}:${generation}:${index}`
      await storage.set(key, chunk)
      knownKeys.add(key)
    }
    await storage.set(HEAD_KEY, { version: 2, generation, chunks: chunks.length })
    knownKeys.add(HEAD_KEY)
  } catch (error) {
    // Release partial writes if the host is reachable. Restart repeats the same sweep.
    const inventory = await readRecorderInventory(storage, knownKeys)
    await reclaimUnusedChunks(storage, inventory, knownKeys)
    throw error
  }
  for (let index = 0; head && index < head.chunks; index++) {
    const key = `${STORAGE_PREFIX}:${head.generation}:${index}`
    await storage.delete(key)
    knownKeys.delete(key)
  }
}
