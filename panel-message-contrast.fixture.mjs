// Deliberately synthetic, stable input for both themes and both view widths.
const HOUR = 3_600_000
const now = Date.parse('2026-11-24T08:00:00Z')
const ago = (hours) => now - hours * HOUR
const segment = (from, to, state) => ({ start: ago(from), end: ago(to), state })
const lane = (id, label, segments) => ({
  id,
  label,
  provider: 'Codex',
  projectId: 'demo',
  projectName: 'Shareable example',
  segments
})
const message = (id, from, to, hours, type) => ({
  id,
  from,
  to,
  at: ago(hours),
  type,
  subject: type,
  ...(type === 'Mailbox received' ? { deliveredAt: ago(hours) + 1000 } : {})
})

export const contrastSnapshot = {
  now,
  windowStart: ago(168),
  collectingSince: ago(168),
  agents: [
    lane('sender', 'A · Coordinator', [
      segment(24, 20, 'working'),
      segment(20, 18, 'blocked'),
      segment(18, 16, 'waiting'),
      segment(16, 14, 'done'),
      segment(14, 3, 'unknown'),
      segment(3, 2.975, 'working'),
      segment(2.975, 2, 'unknown'),
      segment(2, 0, 'working')
    ]),
    lane('crossed', 'B · Review', [
      segment(24, 23, 'working'),
      segment(23, 2, 'unknown'),
      segment(2, 0, 'done')
    ]),
    lane('receiver', 'C · Collector', [segment(24, 10, 'working'), segment(10, 0, 'done')]),
    lane('short', 'D · Short observations', [
      segment(24, 4, 'done'),
      segment(4, 3.975, 'unknown'),
      segment(3.975, 2, 'done'),
      segment(2, 1.975, 'working'),
      segment(1.975, 0, 'done')
    ])
  ],
  messages: [
    message('attempt', 'sender', 'receiver', 13, 'Send attempted'),
    message('accepted', 'sender', 'receiver', 9, 'Send accepted'),
    message('received', 'sender', 'crossed', 5, 'Mailbox received'),
    message('observed', 'sender', 'receiver', 21, 'Send accepted'),
    message('input', null, 'crossed', 17, 'Mailbox received'),
    message('short-mail', 'short', 'crossed', 2, 'Mailbox received')
  ],
  sources: [
    { name: 'Synthetic example', status: 'limited', detail: 'No personal data or live sessions.' }
  ]
}
