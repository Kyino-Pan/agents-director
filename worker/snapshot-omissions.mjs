// Detailed omission evidence can push an otherwise valid timeline over Orca's
// 1 MiB reply limit. Pair the visible rows with one bounded follow-up reply
// from the same snapshot; frame IDs are supplied by the public panel handler.
export function createOmissionReplies() {
  const pending = new Map()
  return {
    prepare(snapshot, frame) {
      const now = Date.now()
      for (const [id, reply] of pending) if (reply.expires <= now) pending.delete(id)
      if (frame) pending.delete(frame)
      const rows = []
      const agents = snapshot.agents.map((agent, index) => {
        if (!agent.omittedActivity?.length) return agent
        const { omittedActivity, ...original } = agent
        // Older callers receive their original coverage notices in one reply.
        if (!frame) return original
        const { omittedRanges, omittedSegments, ...lane } = original
        rows.push({
          index,
          omittedActivity,
          ...(omittedRanges !== undefined && { omittedRanges }),
          ...(omittedSegments !== undefined && { omittedSegments })
        })
        return lane
      })
      if (!rows.length) return { ...snapshot, agents }
      const token = crypto.randomUUID()
      pending.set(frame, { token, rows, expires: now + 30000 })
      return { ...snapshot, agents, omissionToken: token }
    },
    take(frame, token) {
      const reply = pending.get(frame)
      if (!reply || reply.token !== token) return { stale: true }
      pending.delete(frame)
      return { rows: reply.rows }
    }
  }
}
