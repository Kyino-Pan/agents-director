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
