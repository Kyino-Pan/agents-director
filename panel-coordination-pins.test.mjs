import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageFor } from './panel-test-browser.mjs'
import { ActivityStore } from './worker/activity-store.mjs'
import { terminalKey } from './pin-identity.mjs'

const now = Date.UTC(2026, 10, 24, 5, 40)
const messageIds = ['touch-out', 'touch-in', 'unrelated', 'unrelated-input'].sort()
const relevantIds = ['a-000', 'a-001', 'a-002', 'a-003', 'a-004', 'z-center']

function fixture(count, short) {
  const store = new ActivityStore(now - 600000)
  for (const id of [
    ...Array.from({ length: count }, (_, i) => 'a-' + String(i).padStart(3, '0')),
    'z-center'
  ]) {
    store.agent(id, {
      label: id,
      hostId: 'local',
      workspace: 'fixture',
      projectId: 'fixture',
      projectName: 'Pin fixture',
      provider: 'codex',
      sessionId: 'session-' + id
    })
    store.point('history-' + id, id, now - 600000, 'unknown', 'history', now - 500000)
  }
  for (const [id, from, to, age] of [
    ['touch-out', 'z-center', 'a-000', 120000],
    ['touch-in', 'a-001', 'z-center', 90000],
    ['unrelated', 'a-002', 'a-003', 60000],
    ['unrelated-input', null, 'a-004', 30000]
  ])
    store.message({
      id,
      from,
      to,
      at: now - age,
      deliveredAt: now - age + 100,
      type: from === null ? 'Mailbox input' : 'Mailbox received'
    })
  if (short) {
    store.point('short-work', 'z-center', now - 20000, 'working', 'live', now - 10000)
    store.point('short-done', 'z-center', now - 10000, 'done', 'live', now)
  }
  return store
}

async function sample(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('.message-target')]
    return {
      ids: groups.flatMap((el) => JSON.parse(el.dataset.messageIds)).sort(),
      arrows: document.querySelectorAll('.message-path').length,
      inputs: document.querySelectorAll('.mailbox-input').length,
      lanes: [...document.querySelectorAll('.lane[data-agent]')]
        .map((el) => el.dataset.agent)
        .sort(),
      range: ['range-start', 'range-end'].map((id) => document.getElementById(id).value),
      paused: document.getElementById('pause').getAttribute('aria-pressed'),
      paths: [...document.querySelectorAll('.message-path')].map((el) => el.getAttribute('d'))
    }
  })
}

async function watchFrames(page) {
  await page.evaluate(() => {
    window.pinFrameSamples = []
    window.pinFrameCount = 0
    window.pinFrameWatch = true
    const observe = () => {
      if (!window.pinFrameWatch) return
      window.pinFrameCount++
      const sample = {
        ids: [...document.querySelectorAll('.message-target')]
          .flatMap((el) => JSON.parse(el.dataset.messageIds))
          .sort(),
        arrows: document.querySelectorAll('.message-path').length,
        visibleArrows: [...document.querySelectorAll('.message-path')].filter((el) => {
          const style = getComputedStyle(el)
          return (
            style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
          )
        }).length
      }
      if (JSON.stringify(window.pinFrameSamples.at(-1)) !== JSON.stringify(sample))
        window.pinFrameSamples.push(sample)
      requestAnimationFrame(observe)
    }
    requestAnimationFrame(observe)
  })
}

async function screenshot(page, name) {
  if (process.env.DIRECTOR_PIN_EVIDENCE_DIR)
    await page.screenshot({ path: process.env.DIRECTOR_PIN_EVIDENCE_DIR + '/' + name + '.png' })
}

for (const [count, short] of [
  [5, false],
  [160, false],
  [5, true]
]) {
  test(`pin/unpin preserves eligible message endpoints through frames, refresh, poll and reopen with ${count + 1} stored lanes and short filter ${short}`, async (t) => {
    const store = fixture(count, short)
    const raw = store.serialize()
    const pinned = terminalKey(store.agents.get('z-center'))
    const preferences = new Map([
      ['view:window-hours', 1 / 12],
      ['view:hide-short-tasks', short],
      ['view:pinned-terminals', count > 5 || short ? [pinned] : []]
    ])
    const snapshots = []
    const options = {
      preferences,
      width: 1100,
      height: 820,
      getSnapshot(input) {
        const snapshot = store.snapshot(now, input)
        snapshots.push({
          ids: snapshot.messages.map((row) => row.id).sort(),
          lanes: snapshot.agents.map((agent) => agent.id),
          identities: snapshot.agents
            .filter((agent) => relevantIds.includes(agent.id))
            .map(({ id, hostId, workspace, provider, sessionId }) => ({
              id,
              hostId,
              workspace,
              provider,
              sessionId
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          pinned: snapshot.agents.filter((agent) => agent.pinned).map((agent) => agent.id)
        })
        return snapshot
      }
    }
    const phases = []
    const first = await pageFor(options)
    let frames
    try {
      const { page } = first
      await page.locator('.message-target').first().waitFor()
      await page.locator('#pause').click()
      phases.push({ phase: 'initial', ...(await sample(page)) })
      const pin = page.locator('.lane-row:has(.lane[data-agent="z-center"]) .pin-control')
      if (count === 5 && !short) {
        await pin.click()
        await pin.locator('xpath=self::*[@aria-pressed="true"]').waitFor()
        phases.push({ phase: 'pin', ...(await sample(page)) })
      }
      await screenshot(page, 'pins-' + count + (short ? '-short' : '') + '-before')
      await watchFrames(page)
      await pin.click()
      await page.waitForFunction(
        async () => (await window.orca.storage.get('view:pinned-terminals')).length === 0
      )
      await page.waitForTimeout(300)
      phases.push({ phase: 'unpin', ...(await sample(page)) })
      await screenshot(page, 'pins-' + count + (short ? '-short' : '') + '-after')
      await page.evaluate(() => window.notifyActivity())
      await page.waitForTimeout(250)
      phases.push({ phase: 'refresh', ...(await sample(page)) })
      const beforePoll = await page.evaluate(() => window.snapshotRequests.length)
      await page.waitForFunction((n) => window.snapshotRequests.length > n, beforePoll, {
        timeout: 7000
      })
      await page.waitForTimeout(100)
      phases.push({ phase: 'next-5s-poll', ...(await sample(page)) })
      frames = await page.evaluate(() => {
        window.pinFrameWatch = false
        return { count: window.pinFrameCount, samples: window.pinFrameSamples }
      })
      assert.deepEqual(first.errors, [])
    } finally {
      await first.page.close()
    }
    const reopened = await pageFor(options)
    try {
      await reopened.page.locator('.message-target').first().waitFor()
      phases.push({ phase: 'reopen', ...(await sample(reopened.page)) })
      assert.deepEqual(reopened.errors, [])
    } finally {
      await reopened.page.close()
    }
    t.diagnostic(
      JSON.stringify({
        storedLanes: count + 1,
        short,
        phases: phases.map(({ phase, ids, arrows, inputs }) => ({ phase, ids, arrows, inputs })),
        frames: frames.count,
        frameSamples: frames.samples,
        snapshotCounts: [...new Set(snapshots.map((snapshot) => snapshot.ids.length))]
      })
    )
    for (const phase of phases) {
      const filtered = short && phase.phase !== 'initial'
      assert.deepEqual(
        phase.ids,
        filtered ? ['unrelated', 'unrelated-input'] : messageIds,
        phase.phase
      )
      assert.equal(phase.arrows, filtered ? 1 : 3, phase.phase)
      assert.equal(phase.inputs, 1, phase.phase)
      assert.deepEqual(phase.range, phases[0].range, phase.phase)
      assert.ok(
        (filtered ? ['a-002', 'a-003', 'a-004'] : relevantIds).every((id) =>
          phase.lanes.includes(id)
        ),
        phase.phase
      )
      assert.ok(phase.paths.every((path) => !/NaN|undefined/.test(path)))
    }
    const identity = snapshots[0].identities
    for (const snapshot of snapshots) {
      const filtered = short && !snapshot.pinned.includes('z-center')
      assert.deepEqual(snapshot.ids, filtered ? ['unrelated', 'unrelated-input'] : messageIds)
      assert.equal(snapshot.lanes.length, filtered ? count : Math.min(160, count + 1))
      assert.deepEqual(
        snapshot.identities,
        filtered ? identity.filter((row) => row.id !== 'z-center') : identity
      )
    }
    assert.ok(frames.count > 2)
    for (const frame of frames.samples) {
      const filtered = short && frame.ids.length === 2
      assert.deepEqual(frame.ids, filtered ? ['unrelated', 'unrelated-input'] : messageIds)
      assert.equal(frame.arrows, filtered ? 1 : 3)
      assert.equal(frame.visibleArrows, filtered ? 1 : 3)
    }
    assert.deepEqual(preferences.get('view:pinned-terminals'), [])
    assert.deepEqual(store.serialize(), raw)
  })
}
