// Application policy below the public bridge's 1 MiB ceiling. These conservative
// weights leave room for transport overhead; they do not model host internals.
const REPLY_BUDGET = 1024 * 1024 - 4096
// An independent application limit on object/array complexity. It deliberately
// does not attempt to reproduce the bridge validator's private accounting.
const CONTAINER_BUDGET = 8192

export function replyCost(value) {
  let containers = 0
  function weight(value) {
    if (value === null) return 4
    if (typeof value === 'boolean') return 4
    if (typeof value === 'number') return Math.max(16, String(value).length)
    if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value))
    containers++
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + weight(item) + 1, 8)
    return Object.entries(value).reduce(
      (sum, [key, item]) => sum + Buffer.byteLength(JSON.stringify(key)) + 4 + weight(item),
      8
    )
  }
  const bytes = weight(value)
  return { bytes, containers }
}

export const replyWeight = (value) => replyCost(value).bytes
export function replyFits(value) {
  const { bytes, containers } = replyCost(value)
  return bytes <= REPLY_BUDGET && containers <= CONTAINER_BUDGET
}

// Rebuild from the same observations/clock, rather than trimming a clipped reply.
// Only interval fill changes: lanes, messages, events and reserved intervals stay.
export function prepareSnapshotReply(store, now, options, prepare, fits = replyFits) {
  const snapshot = (segmentBudget) =>
    store.snapshot(now, { ...options, segmentBudget, preferActivity: segmentBudget < 4000 })
  const full = snapshot(4000)
  const reply = prepare(full)
  if (fits(reply)) return reply

  let best = snapshot(0)
  const floor = prepare(best)
  // The policy estimates room for optional fill, not host acceptance. Submit the
  // intact protected floor if even it exceeds our estimate: the public bridge
  // remains the authority, and no messages/events are removed to force a fit.
  if (!fits(floor)) return floor
  // Bounded search finds a fitting fill at 32-place granularity, using the existing
  // fair-share policy. Mandatory endpoint/latest intervals may exceed this fill.
  let low = 0
  let high = 4000
  while (high - low > 32) {
    const budget = Math.floor((low + high) / 2)
    const candidate = snapshot(budget)
    if (fits(prepare(candidate))) {
      low = budget
      best = candidate
    } else high = budget
  }
  // Probes replace the frame's omission token. Bind the final reply again.
  return prepare(best)
}
