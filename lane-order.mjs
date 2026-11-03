const EXACT_LIMIT = 14
const cachedOrders = new Map()

function connections(agents, messages, start, end) {
  const ids = new Set(agents.map((agent) => agent.id))
  const edges = messages
    .filter((message) => message.at >= start && message.at <= end)
    .map((message) => [message.from, message.to])
  for (const agent of agents) {
    if (Number.isFinite(agent.spawnedAt) && agent.spawnedAt >= start && agent.spawnedAt <= end) {
      edges.push([agent.parentId, agent.id])
    }
  }
  return edges.filter(([from, to]) => from !== to && ids.has(from) && ids.has(to))
}

function activityTimes(agents, messages, start, end) {
  const times = new Map(agents.map((agent) => [agent.id, -Infinity]))
  const record = (id, at) => {
    if (times.has(id) && Number.isFinite(at) && at >= start && at <= end) {
      times.set(id, Math.max(times.get(id), at))
    }
  }
  for (const agent of agents) {
    record(agent.id, agent.spawnedAt)
    for (const segment of agent.segments) {
      if (segment.state === 'done') {
        record(agent.id, segment.start)
      } else if (
        ['working', 'blocked', 'waiting'].includes(segment.state) &&
        segment.start <= end
      ) {
        record(agent.id, Math.min(end, segment.end))
      }
    }
  }
  for (const message of messages) {
    record(message.from, message.at)
    record(message.to, message.at)
  }
  return times
}

function exactOrder(weights, external) {
  const n = weights.length
  const size = 1 << n
  const counts = new Uint8Array(size)
  const cuts = new Float64Array(size)
  const costs = new Float64Array(size)
  const degrees = weights.map((row) => row.reduce((sum, value) => sum + value, 0))
  for (let mask = 1; mask < size; mask++) {
    const bit = mask & -mask
    const i = 31 - Math.clz32(bit)
    const previous = mask ^ bit
    counts[mask] = counts[previous] + 1
    cuts[mask] = cuts[previous] + degrees[i]
    for (let j = 0; j < n; j++) {
      if (previous & (1 << j)) {
        cuts[mask] -= 2 * weights[i][j]
      }
    }
  }
  for (let mask = size - 2; mask >= 0; mask--) {
    costs[mask] = Infinity
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) {
        const next = mask | (1 << i)
        costs[mask] = Math.min(costs[mask], external[i] * counts[mask] + cuts[next] + costs[next])
      }
    }
  }
  const order = []
  let mask = 0
  while (order.length < n) {
    for (let i = 0; i < n; i++) {
      const next = mask | (1 << i)
      if (next !== mask && costs[mask] === external[i] * order.length + cuts[next] + costs[next]) {
        order.push(i)
        mask = next
        break
      }
    }
  }
  return order
}

function earlier(order, other) {
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== other[i]) {
      return order[i] < other[i]
    }
  }
  return false
}

function swapCost(order, at, weights, external) {
  const a = order[at]
  const b = order[at + 1]
  let delta = external[a] - external[b]
  for (let i = 0; i < order.length; i++) {
    if (i < at) {
      delta += weights[a][order[i]] - weights[b][order[i]]
    } else if (i > at + 1) {
      delta += weights[b][order[i]] - weights[a][order[i]]
    }
  }
  return delta
}

function boundedOrder(weights, external) {
  let order = weights.map((_, i) => i)
  for (let pass = 0; pass < 6; pass++) {
    let best = order
    let improvement = 0
    for (let from = 0; from < order.length; from++) {
      for (const direction of [-1, 1]) {
        const candidate = [...order]
        let delta = 0
        for (let to = from + direction; to >= 0 && to < order.length; to += direction) {
          const at = direction === 1 ? to - 1 : to
          delta += swapCost(candidate, at, weights, external)
          const swapped = candidate[at]
          candidate[at] = candidate[at + 1]
          candidate[at + 1] = swapped
          if (delta < improvement || (delta === improvement && earlier(candidate, best))) {
            improvement = delta
            best = [...candidate]
          }
        }
      }
    }
    if (best === order) {
      break
    }
    order = best
  }
  return order
}

function compactGroup(agents, edges, projectByAgent, project) {
  const indices = new Map(agents.map((agent, i) => [agent.id, i]))
  const weights = agents.map(() => new Float64Array(agents.length))
  const external = new Float64Array(agents.length)
  for (const [from, to] of edges) {
    const a = indices.get(from)
    const b = indices.get(to)
    if (a !== undefined && b !== undefined) {
      weights[a][b]++
      weights[b][a]++
    } else if (a !== undefined) {
      external[a] += projectByAgent.get(to) < project ? 1 : -1
    } else if (b !== undefined) {
      external[b] += projectByAgent.get(from) < project ? 1 : -1
    }
  }
  // Fixed project bands make cross-project distances linear in each lane's position.
  const signature = JSON.stringify([
    agents.map((agent) => agent.id),
    weights.map((row) => [...row]),
    [...external]
  ])
  let order = cachedOrders.get(signature)
  if (!order) {
    order =
      agents.length <= EXACT_LIMIT ? exactOrder(weights, external) : boundedOrder(weights, external)
    if (cachedOrders.size >= 32) {
      cachedOrders.clear()
    }
    cachedOrders.set(signature, order)
  }
  return order.map((i) => agents[i])
}

export function orderProjectLanes(agents, messages, start, end, compact = false) {
  const groups = new Map()
  for (const agent of agents) {
    const project = agent.projectId || '__unknown__'
    if (!groups.has(project)) {
      groups.set(project, [])
    }
    groups.get(project).push(agent)
  }
  const times = activityTimes(agents, messages, start, end)
  const ordered = [...groups.values()].map((group) =>
    group.sort((a, b) => times.get(b.id) - times.get(a.id) || a.id.localeCompare(b.id))
  )
  if (!compact) {
    return ordered.flat()
  }
  const projectByAgent = new Map(ordered.flatMap((group, i) => group.map((agent) => [agent.id, i])))
  const edges = connections(agents, messages, start, end)
  return ordered.flatMap((group, i) => compactGroup(group, edges, projectByAgent, i))
}
