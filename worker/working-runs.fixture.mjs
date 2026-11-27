// Exact bounded observations from the frozen Claude cases. Identities are
// pseudonyms; each neighbourhood ends at its right Working coverage endpoint.
export const frozenWorkingRuns = [
  {
    name: 'Claude 4897 ms',
    gap: 4897,
    points: [
      [1795587649829, 1795588472241, 'working'],
      [1795588473900, 1795588473900, 'done'],
      [1795588477138, 1795588513991, 'working']
    ]
  },
  {
    name: 'Claude 5278 ms',
    gap: 5278,
    points: [
      [1795675725471, 1795675741257, 'working'],
      [1795675743296, 1795675743379, 'done'],
      [1795675746535, 1795675762426, 'working']
    ]
  }
]
