// Segments are ordered and disjoint. A transition belongs to the interval starting there.
export function segmentAt(segments, at) {
  let low = 0
  let high = segments.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const segment = segments[mid]
    if (at < segment.start) high = mid
    else if (at >= segment.end) low = mid + 1
    else return segment
  }
}

// A change observed across an uncovered gap can only be placed inside a view
// when both bounds fit. A resumed poll cannot date a completion during downtime.
export function completionInWindow(segment, start, end) {
  return segment.completionSince >= start && segment.start <= end
}

export function eventInWindow(event, start, end) {
  return (
    event.at >= start &&
    event.at <= end &&
    (event.state !== 'done' || event.completionSince >= start)
  )
}

export function isActiveState(state) {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

// The worker sends sorted pairs of endpoints for omitted active intervals.
// Adjacent active states can share a range; uncovered time is never bridged.
export function overlapsOmittedActivity(agent, start, end) {
  const bounds = agent.omittedActivity
  if (!bounds) return false
  for (let i = 0; i < bounds.length && bounds[i] < end; i += 2) {
    if (bounds[i + 1] > start) return true
  }
  return false
}
