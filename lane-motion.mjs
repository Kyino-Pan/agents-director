export const spawnPath = (x, from, to) =>
  `M ${x - 14} ${from} C ${x} ${from}, ${x} ${to}, ${x + 14} ${to}`

export const messagePath = (x, from, to, self = from === to) =>
  self
    ? `M ${x} ${from - 12} C ${x + 28} ${from - 36}, ${x + 28} ${from + 20}, ${x + 2} ${from + 12}`
    : `M ${x} ${from} L ${x} ${to}`

export function createLaneMotion(lanes, chart) {
  const preference = matchMedia('(prefers-reduced-motion: reduce)')
  const cancel = () => {
    for (const root of [lanes, chart]) {
      for (const animation of root.getAnimations({ subtree: true })) {
        if (animation.id === 'lane-reorder') {
          animation.cancel()
        }
      }
    }
  }
  const changed = () => {
    if (preference.matches) {
      cancel()
    }
  }
  preference.addEventListener('change', changed)
  const animate = (element, frames) => {
    element.animate(frames, { id: 'lane-reorder', duration: 200, easing: 'ease-out' })
  }
  const move = (element, delta) => {
    if (Math.abs(delta) > 0.1) {
      animate(element, [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }])
    }
  }
  return {
    capture() {
      if (preference.matches || !lanes.getClientRects().length) {
        return new Map()
      }
      const top = lanes.getBoundingClientRect().top
      return new Map(
        [...lanes.querySelectorAll('[data-agent]')].map((element) => {
          const box = element.getBoundingClientRect()
          return [element.dataset.agent, box.top + box.height / 2 - top]
        })
      )
    },
    apply(previous, positions) {
      if (preference.matches || !previous.size) {
        return
      }
      const delta = (id) => (previous.get(id) ?? positions.get(id)) - positions.get(id)
      for (const element of [
        ...lanes.querySelectorAll('[data-agent]'),
        ...chart.querySelectorAll('.segment-target')
      ]) {
        move(element, delta(element.dataset.agent))
      }
      for (const element of chart.querySelectorAll('[data-from][data-to]')) {
        const { from, to } = element.dataset
        const fromDelta = delta(from)
        const toDelta = delta(to)
        if (Math.abs(fromDelta) <= 0.1 && Math.abs(toDelta) <= 0.1) {
          continue
        }
        const path = element.classList.contains('spawn') ? spawnPath : messagePath
        const x = Number(element.dataset.x)
        const before = path(
          x,
          positions.get(from) + fromDelta,
          positions.get(to) + toDelta,
          from === to
        )
        const after = path(x, positions.get(from), positions.get(to), from === to)
        for (const line of element.matches('path') ? [element] : element.querySelectorAll('path')) {
          animate(line, [{ d: `path("${before}")` }, { d: `path("${after}")` }])
        }
        const dot = element.querySelector('.message-dot')
        const count = element.querySelector('.message-count')
        if (dot) {
          move(dot, fromDelta)
        }
        if (count) {
          move(count, (fromDelta + toDelta) / 2)
        }
      }
    },
    dispose() {
      preference.removeEventListener('change', changed)
      cancel()
    }
  }
}
