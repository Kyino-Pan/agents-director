import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderProjectLanes } from './lane-order.mjs'

const END = 100000
const agent = (id, projectId = 'project', at = END - Number(id) - 1) => ({
  id: String(id),
  projectId,
  segments: [{ start: at, end: END, state: 'done' }]
})
const message = (from, to, at = 100) => ({ from: String(from), to: String(to), at })
const ids = (agents) => agents.map((item) => item.id)

function permutations(items) {
  if (!items.length) {
    return [[]]
  }
  return items.flatMap((item, i) =>
    permutations(items.filter((_, j) => i !== j)).map((rest) => [item, ...rest])
  )
}

function length(order, edges) {
  const positions = new Map()
  let y = 0
  let previous
  for (const item of order) {
    if (item.projectId !== previous) {
      y += 30
      previous = item.projectId
    }
    positions.set(item.id, y)
    y += 32
  }
  return edges.reduce(
    (total, [from, to]) => total + Math.abs(positions.get(from) - positions.get(to)),
    0
  )
}

test('default activity order uses observed work, completion, spawn and messages without extending done or unknown', () => {
  const agents = [
    agent('done', 'p', 10),
    { ...agent('unknown'), segments: [{ start: 90, end: END, state: 'unknown' }] },
    { ...agent('working'), segments: [{ start: 50, end: 500, state: 'working' }] },
    { ...agent('spawn'), segments: [], spawnedAt: 300 },
    { ...agent('mail'), segments: [] }
  ].map((item) => ({ ...item, projectId: 'p' }))
  const messages = [message('mail', 'missing', 400), message('done', 'missing', END + 1)]
  assert.deepEqual(ids(orderProjectLanes(agents, messages, 0, END)), [
    'working',
    'mail',
    'spawn',
    'done',
    'unknown'
  ])
  assert.deepEqual(ids(orderProjectLanes(agents, [], 0, END, true)), [
    'working',
    'spawn',
    'done',
    'mail',
    'unknown'
  ])
})

test('exact layout matches exhaustive minimum and activity tie-break for weighted messages plus spawns', () => {
  const agents = Array.from({ length: 6 }, (_, i) => agent(i))
  agents[1].parentId = '5'
  agents[1].spawnedAt = 50
  const messages = [message(0, 5), message(0, 5), message(1, 4), message(4, 2), message(3, 5)]
  const edges = messages.map(({ from, to }) => [from, to]).concat([['5', '1']])
  const candidates = permutations(agents)
  const minimum = Math.min(...candidates.map((order) => length(order, edges)))
  const expected = candidates.find((order) => length(order, edges) === minimum)
  const result = orderProjectLanes(agents, messages, 0, END, true)
  assert.equal(length(result, edges), minimum)
  assert.deepEqual(ids(result), ids(expected))
  assert.deepEqual(ids(orderProjectLanes(agents, messages, 1000, END, true)), ids(agents))
  assert.deepEqual(ids(orderProjectLanes(agents.toReversed(), messages, 0, END, true)), ids(result))
})

test('cross-project edges influence lanes while bands stay fixed, and hidden endpoints do not influence layout', () => {
  const first = [agent(0, 'a'), agent(1, 'a'), agent(2, 'a')]
  const second = [agent(3, 'b'), agent(4, 'b'), agent(5, 'b')]
  const messages = [message(0, 5), message(0, 5), message(1, 2), message(3, 4)]
  const edges = messages.map(({ from, to }) => [from, to])
  const orders = permutations(first).flatMap((a) => permutations(second).map((b) => [...a, ...b]))
  const minimum = Math.min(...orders.map((order) => length(order, edges)))
  const result = orderProjectLanes([...first, ...second], messages, 0, END, true)
  assert.equal(length(result, edges), minimum)
  assert.deepEqual(ids(result), ids(orders.find((order) => length(order, edges) === minimum)))
  assert.deepEqual(
    result.map((item) => item.projectId),
    ['a', 'a', 'a', 'b', 'b', 'b']
  )
  assert.deepEqual(ids(orderProjectLanes(first, [message(0, 'hidden')], 0, END, true)), ids(first))
})

test('large layouts deterministically improve the objective without losing lanes or mutating the input', () => {
  const agents = Array.from({ length: 40 }, (_, i) => agent(i))
  const messages = Array.from({ length: 20 }, (_, i) => message(i, 39 - i))
  const before = structuredClone(agents)
  const edges = messages.map(({ from, to }) => [from, to])
  const result = orderProjectLanes(agents, messages, 0, END, true)
  assert.ok(length(result, edges) < length(agents, edges))
  assert.equal(new Set(ids(result)).size, agents.length)
  assert.deepEqual(agents, before)
  assert.deepEqual(ids(orderProjectLanes(agents, messages, 0, END, true)), ids(result))
  assert.deepEqual(ids(orderProjectLanes(agents, messages, 0, END)), ids(agents))
})
