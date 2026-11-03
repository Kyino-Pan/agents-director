const HOUR = 3_600_000
const now = Date.parse('2026-11-02T08:00:00Z')
const ago = (hours) => now - hours * HOUR
const segment = (from, to, state) => ({
  start: ago(from),
  end: ago(to),
  state,
  source: 'agent.status.changed'
})

export const snapshot = {
  now,
  windowStart: ago(168),
  collectingSince: ago(168),
  limited: true,
  agents: [
    {
      id: 'lead',
      label: 'Coordinator',
      sessionId: 'session_demo_coordinator',
      providerSessionId: 'provider_demo_coordinator',
      paneKey: 'orca:main:terminal:coordinator',
      terminalHandle: 'term_demo_coordinator',
      runId: 'run_demo_coordinator',
      taskId: 'task_demo_coordinator',
      dispatchId: 'ctx_demo_coordinator',
      provider: 'Codex',
      projectId: 'orca',
      projectName: 'Orca',
      workspace: 'orca / main',
      segments: [
        segment(19, 16, 'working'),
        segment(16, 14, 'waiting'),
        segment(14, 7, 'working'),
        segment(7, 5, 'blocked'),
        segment(5, 0, 'working')
      ]
    },
    {
      id: 'ui',
      label: 'Activity interface',
      provider: 'Codex',
      projectId: 'orca',
      projectName: 'Orca',
      workspace: 'orca / activity-ui',
      parentId: 'lead',
      spawnedAt: ago(15),
      segments: [
        segment(15, 10, 'working'),
        segment(10, 8, 'blocked'),
        segment(8, 3, 'working'),
        segment(3, 0, 'done')
      ]
    },
    {
      id: 'ui-review',
      label: 'Interface review',
      provider: 'Claude',
      projectId: 'orca',
      projectName: 'Orca',
      workspace: 'orca / activity-ui',
      parentId: 'ui',
      spawnedAt: ago(6),
      segments: [segment(6, 3, 'working'), segment(3, 0, 'waiting')]
    },
    {
      id: 'collector',
      label: 'Activity collector',
      provider: 'Codex',
      projectId: 'orca',
      projectName: 'Orca',
      workspace: 'orca / activity-worker',
      parentId: 'lead',
      spawnedAt: ago(17),
      segments: [
        segment(17, 12, 'working'),
        segment(12, 9, 'unknown'),
        segment(9, 1, 'working'),
        segment(1, 0, 'unknown')
      ]
    },
    {
      id: 'tests',
      label: 'Integration checks across remote environments',
      provider: 'Claude',
      projectId: 'orca',
      projectName: 'Orca',
      workspace: 'orca / activity-tests',
      parentId: 'collector',
      spawnedAt: ago(9),
      segments: [segment(9, 5, 'working'), segment(5, 2, 'blocked'), segment(2, 0, 'working')]
    },
    {
      id: 'docs',
      label: 'Plugin documentation',
      provider: 'Codex',
      projectId: 'docs',
      projectName: 'Documentation',
      workspace: 'docs / plugins',
      segments: [
        segment(160, 120, 'working'),
        segment(120, 21, 'done'),
        segment(21, 18, 'working'),
        segment(18, 0, 'done')
      ]
    }
  ],
  messages: [
    {
      id: 'm1',
      from: 'lead',
      to: 'collector',
      at: ago(16.5),
      type: 'task',
      subject: 'Collect observed agent states',
      body: 'Keep the rolling window to 24 hours. Preserve unknown intervals.',
      deliveredAt: ago(16.49)
    },
    {
      id: 'm2',
      from: 'lead',
      to: 'ui',
      at: ago(14),
      type: 'message',
      subject: 'Timeline API is ready',
      body: 'Use the snapshot endpoint for the initial render.',
      deliveredAt: ago(13.99)
    },
    {
      id: 'm3',
      from: 'ui',
      to: 'lead',
      at: ago(10),
      type: 'ask',
      subject: 'Confirm source coverage',
      body: 'Should unavailable remote activity appear as a coverage notice?',
      deliveredAt: ago(9.99)
    },
    {
      id: 'm4',
      from: 'lead',
      to: 'ui',
      at: ago(8),
      type: 'reply',
      subject: 'Show the coverage notice',
      body: 'Yes. Include the source detail without inferring a missing state.',
      deliveredAt: ago(7.99)
    },
    {
      id: 'm5',
      from: 'collector',
      to: 'tests',
      at: ago(5.5),
      type: 'message',
      subject: 'Collector ready for checks',
      body: 'Verify the gap between observations and restart recovery.',
      deliveredAt: ago(5.49)
    },
    {
      id: 'm6',
      from: 'ui-review',
      to: 'ui',
      at: ago(2.5),
      type: 'worker_done',
      subject: 'Review complete',
      body: 'Keyboard and narrow-panel review complete.',
      deliveredAt: ago(2.49)
    },
    {
      id: 'm7',
      from: 'tests',
      to: 'lead',
      at: ago(0.5),
      type: 'message',
      subject: 'Checks in progress',
      body: '<img src=x onerror="alert(1)"> is literal message text, never markup.'
    }
  ],
  sources: [
    {
      name: 'Agent status events',
      status: 'ok',
      detail: 'Observed state changes from Orca agents.'
    },
    {
      name: 'Orchestration messages',
      status: 'ok',
      detail: 'Messages between Orca orchestration agents. Provider conversations are excluded.'
    },
    {
      name: 'Remote history',
      status: 'limited',
      detail: 'History from disconnected hosts is unavailable.'
    }
  ]
}

// Keep friendly fixture references above while exercising full canonical IDs in the UI.
const ids = new Map(
  snapshot.agents.map((agent, index) => [
    agent.id,
    `agent_019a421e-91ce-7d7e-b426-98be092731f${index}`
  ])
)
for (const agent of snapshot.agents) {
  agent.id = ids.get(agent.id)
  if (agent.parentId) {
    agent.parentId = ids.get(agent.parentId)
  }
}
for (const message of snapshot.messages) {
  message.from = ids.get(message.from)
  message.to = ids.get(message.to)
}
