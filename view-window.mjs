// The recorder keeps its seven-day bounds separately from the requested plot.
// A null end follows the worker's clock; an explicit end anchors a pan or pause.
export function viewWindow(now, oldest, view) {
  if (!Number.isFinite(view?.hours) || view.hours <= 0) return null
  if (view.end != null && !Number.isFinite(view.end)) return null
  const span = Math.min(now - oldest, view.hours * 3_600_000)
  const end = Math.min(now, Math.max(oldest + span, view.end ?? now))
  return { start: end - span, end }
}
