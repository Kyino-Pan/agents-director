import { deflateSync, inflateSync } from 'node:zlib'

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
