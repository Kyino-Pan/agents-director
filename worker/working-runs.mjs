const PREFIX = 'working-run:'
const rank = { orchestration: 0, 'status-cache': 1, transcript: 2, journal: 3, live: 4 }
const canonical = (point) => point.id.startsWith(PREFIX)

// The v2 point schema stays unchanged. A canonical ID distinguishes a confirmed
// run from an older bounded sample when delayed history arrives inside it.
export function normalizeWorkingRuns(agent, points) {
  if (agent.id.startsWith('public-terminal:') || !(agent.sessionId || agent.providerSessionId))
    return points
  const ordered = [...points].sort(
    (a, b) => a.at - b.at || (rank[a.source] ?? 0) - (rank[b.source] ?? 0)
  )
  const observations = []
  for (const point of ordered) {
    const previous = observations.at(-1)
    if (
      point.state === 'working' &&
      previous?.state === 'working' &&
      Number.isFinite(point.until) &&
      Number.isFinite(previous.until) &&
      point.at <= previous.until &&
      !point.unsettled &&
      !previous.unsettled
    ) {
      previous.until = Math.max(previous.until, point.until)
      previous.members.push(point)
    } else observations.push({ ...point, members: [point] })
  }
  const runs = []
  const boundaries = ordered.filter(
    (point) => point.source === 'identity-change' || point.unsettled
  )
  for (let i = 0; i < observations.length; i++) {
    const point = observations[i]
    if (point.state !== 'working' || !Number.isFinite(point.until) || point.unsettled) continue
    const end = point.members.some(canonical)
      ? point.until
      : Math.min(point.until, observations[i + 1]?.at ?? point.until)
    const previous = runs.at(-1)
    if (
      previous &&
      point.at - previous.until < 30000 &&
      !boundaries.some((boundary) => boundary.at > previous.at && boundary.at <= point.at)
    ) {
      previous.until = Math.max(previous.until, end)
      previous.members.push(...point.members)
    } else runs.push({ ...point, until: end, members: [...point.members] })
  }
  const confirmed = runs.filter((run) => run.members.length > 1 || run.members.some(canonical))
  if (!confirmed.length) return points
  const memberIds = new Set(confirmed.flatMap((run) => run.members.map((point) => point.id)))
  const result = []
  let runIndex = 0
  for (let i = 0; i < ordered.length; i++) {
    const point = ordered[i]
    if (memberIds.has(point.id)) continue
    if (point.source === 'identity-change' || point.unsettled) {
      result.push(point)
      continue
    }
    while (runIndex < confirmed.length && confirmed[runIndex].until <= point.at) runIndex++
    const run = confirmed[runIndex]
    if (run && point.at >= run.at) {
      // A delayed bounded interval may still prove its endpoint after the run.
      // Retain that observation, without inventing a completion inside the run.
      const end = Math.min(point.until ?? point.at, ordered[i + 1]?.at ?? Infinity)
      if (end > run.until) result.push({ ...point, at: end, until: end })
      continue
    }
    result.push(point)
  }
  for (const run of confirmed) {
    const anchor = run.members.find(canonical) ?? run.members[0]
    result.push({
      ...anchor,
      id: canonical(anchor) ? anchor.id : PREFIX + anchor.id,
      at: run.at,
      until: run.until
    })
  }
  return result
}
