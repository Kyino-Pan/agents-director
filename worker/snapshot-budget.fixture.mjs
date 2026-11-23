import { ActivityStore } from './activity-store.mjs'

export const fixtureNow = Date.parse('2026-11-02T08:00:00Z')

export function denseRecorder() {
  const now = fixtureNow
  const store = new ActivityStore(now - 2 * 86400000)
  function sampled(id, count, end, step = 60000) {
    store.agent(id, {
      label: id + ' session',
      provider: 'codex',
      projectName: 'Coordination',
      projectId: 'demo'
    })
    for (let i = 0; i < count; i++) {
      const at = end - (count - i) * step
      store.point(id + i, id, at, i % 2 ? 'done' : 'working', 'live', at + step / 2)
    }
  }
  // The first 15 names alone exceed the segment budget in label order.
  for (let i = 0; i < 15; i++) {
    sampled('A-' + String(i).padStart(2, '0'), i === 0 ? 300 : 125, now - 36 * 3600000)
  }
  for (let i = 0; i < 35; i++) sampled('B-' + i, 1, now - 36 * 3600000)
  sampled('Coordinator', 400, now)
  sampled('Reviewer', 3, now - 60000)
  sampled('Worker', 8, now)
  for (const [from, to, age] of [
    ['Coordinator', 'Worker', 140000],
    ['Reviewer', 'Coordinator', 100000],
    [null, 'Mailbox', 60000]
  ]) {
    store.message({
      id: 'mail-' + to,
      from,
      to,
      at: now - age,
      type: from ? 'Send accepted' : 'Mailbox input'
    })
  }
  // Older traffic is outside the five-minute view. Across the snapshot these
  // three sampled participants have 2, 12 and 3 message references.
  const peers = ['Reviewer', 'Worker', 'Worker', ...Array(7).fill('B-0')]
  peers.forEach((from, i) => {
    store.message({
      id: 'older-' + i,
      from,
      to: 'Coordinator',
      at: now - 8 * 3600000 - i * 60000,
      type: 'Send accepted'
    })
  })
  store.agent('Mailbox', {
    label: 'Mailbox monitor',
    provider: 'claude',
    projectName: 'Coordination',
    projectId: 'demo'
  })
  return store
}
