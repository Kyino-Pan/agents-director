import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TerminalMemory } from './terminal-memory.mjs'
import { defaultDataDirectory } from './orca-log-reader.mjs'

function fixture() {
  const agent = {
    id: 'agent',
    workspace: 'worktree:repo::/work',
    paneKey: 'tab:leaf',
    terminalHandle: 'term_one'
  }
  const store = { aliases: new Map([['pane:tab:leaf', agent.id]]) }
  const snapshot = { agents: [agent] }
  const terminal = {
    handle: 'term_one',
    worktreeId: 'repo::/work',
    tabId: 'tab',
    leafId: 'leaf',
    executionHostId: 'local',
    connected: true,
    orphaned: false,
    verdict: 'live',
    ptyId: 'pty'
  }
  const session = { sessionId: 'pty', paneKey: 'tab:leaf', pid: 42, memory: 128 * 1024 ** 2 }
  const diagnostics = {
    collectedAt: Date.now(),
    processMemoryMetric: 'footprint',
    worktrees: [{ worktreeId: 'repo::/work', sessions: [session] }]
  }
  const inventory = { terminals: [terminal] }
  const calls = []
  let connects = 0
  const connect = async () => {
    connects++
    return async (method, params) => {
      calls.push({ method, params })
      return method === 'diagnostics.memory' ? diagnostics : inventory
    }
  }
  const memory = new TerminalMemory(store, [defaultDataDirectory()], () => {}, connect)
  const sample = async () => {
    memory.snapshot(snapshot)
    await memory.pending
    return memory.snapshot(snapshot)
  }
  return {
    agent,
    store,
    snapshot,
    terminal,
    session,
    diagnostics,
    inventory,
    calls,
    connect,
    memory,
    sample,
    connects: () => connects
  }
}

test('exact local terminal receives transient memory, and older hosts without verdict remain supported', async () => {
  for (const verdict of ['live', undefined]) {
    const f = fixture()
    f.terminal.verdict = verdict
    const before = JSON.stringify(f.snapshot)
    const result = await f.sample()
    assert.deepEqual(result.agents[0].memory, {
      bytes: f.session.memory,
      metric: 'footprint',
      collectedAt: f.diagnostics.collectedAt
    })
    assert.equal(JSON.stringify(f.snapshot), before)
    assert.deepEqual(f.calls[1].params, {
      worktree: 'id:repo::/work',
      limit: 256,
      includePreview: false,
      includeVisualLayouts: false,
      requireFreshPtyLiveness: true
    })
    f.memory.close()
  }
})

test('unavailable, remote, ambiguous and stale samples never become memory badges', async (t) => {
  const cases = {
    remote: (f) => {
      f.terminal.executionHostId = 'ssh:host'
    },
    unknownHost: (f) => {
      delete f.terminal.executionHostId
    },
    disconnected: (f) => {
      f.terminal.connected = false
    },
    orphaned: (f) => {
      f.terminal.orphaned = true
    },
    unknownLiveness: (f) => {
      f.terminal.verdict = 'unknown'
    },
    stale: (f) => {
      f.diagnostics.collectedAt -= 61_000
    },
    future: (f) => {
      f.diagnostics.collectedAt += 61_000
    },
    unsupportedMetric: (f) => {
      f.diagnostics.processMemoryMetric = 'other'
    },
    negative: (f) => {
      f.session.memory = -1
    },
    invalid: (f) => {
      f.session.memory = NaN
    },
    unknownPid: (f) => {
      f.session.pid = 0
    },
    wrongPty: (f) => {
      f.session.sessionId = 'other'
    },
    wrongPane: (f) => {
      f.session.paneKey = 'other:leaf'
    },
    wrongWorkspace: (f) => {
      f.terminal.worktreeId = 'other'
    },
    duplicateTerminal: (f) => {
      f.inventory.terminals.push({ ...f.terminal })
    },
    duplicateSession: (f) => {
      f.diagnostics.worktrees[0].sessions.push({ ...f.session })
    },
    incompleteInventory: (f) => {
      f.inventory.truncated = true
    },
    historicOwner: (f) => {
      f.store.aliases.set('pane:tab:leaf', 'new-agent')
    },
    nativeChat: (f) => {
      f.agent.paneKey = 'structured-agent-session-chat:leaf'
      f.store.aliases.set(`pane:${f.agent.paneKey}`, f.agent.id)
    }
  }
  for (const [name, change] of Object.entries(cases))
    await t.test(name, async () => {
      const f = fixture()
      change(f)
      assert.equal((await f.sample()).agents[0].memory, undefined)
      f.memory.close()
    })
})

test('a cached sample cannot survive an ownership change, changed address or expiry', async () => {
  const f = fixture()
  await f.sample()
  f.store.aliases.set('pane:tab:leaf', 'replacement')
  assert.equal(f.memory.snapshot(f.snapshot).agents[0].memory, undefined)
  f.store.aliases.set('pane:tab:leaf', f.agent.id)
  f.agent.terminalHandle = 'term_new'
  assert.equal(f.memory.snapshot(f.snapshot).agents[0].memory, undefined)
  f.agent.terminalHandle = 'term_one'
  assert.equal(
    f.memory.snapshot(f.snapshot, f.diagnostics.collectedAt + 60_001).agents[0].memory,
    undefined
  )
  await f.memory.pending
  f.memory.close()
})

test('polling coalesces requests, throttles failures and clears failed samples', async () => {
  const f = fixture()
  const now = Date.now()
  f.memory.snapshot(f.snapshot, now)
  const pending = f.memory.pending
  f.memory.snapshot(f.snapshot, now + 1)
  assert.equal(f.memory.pending, pending)
  await pending
  f.memory.snapshot(f.snapshot, now + 29_999)
  assert.equal(f.connects(), 1)
  f.memory.connect = async () => {
    throw new Error('offline')
  }
  f.memory.snapshot(f.snapshot, now + 30_000)
  await f.memory.pending
  assert.equal(f.memory.samples.size, 0)
  assert.equal(f.memory.nextPoll, now + 60_000)
  f.memory.snapshot(f.snapshot, now + 30_001)
  assert.equal(f.memory.pending, null)
  f.memory.close()
})

test('imported sources never connect and closing prevents a pending sample from publishing', async () => {
  const f = fixture()
  for (const directories of [['/import'], [defaultDataDirectory(), '/import']]) {
    const memory = new TerminalMemory(f.store, directories, () => {}, f.connect)
    assert.equal(memory.snapshot(f.snapshot), f.snapshot)
    assert.equal(f.connects(), 0)
  }
  let finish
  let notified = false
  f.memory.connect = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  f.memory.changed = () => {
    notified = true
  }
  f.memory.snapshot(f.snapshot)
  const pending = f.memory.pending
  f.memory.close()
  finish(async () => f.diagnostics)
  await pending
  assert.equal(f.memory.samples.size, 0)
  assert.equal(notified, false)
})

test('current pane ownership recovers rotated or missing handles without attributing historical owners', async () => {
  for (const handle of ['term_rotated', undefined]) {
    const f = fixture()
    f.agent.terminalHandle = handle
    assert.ok((await f.sample()).agents[0].memory)
    f.store.aliases.set('pane:tab:leaf', 'replacement')
    assert.equal(f.memory.snapshot(f.snapshot).agents[0].memory, undefined)
    f.memory.close()
  }
})
