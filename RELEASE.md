# v0.2.3

Changes since [v0.2.2](https://github.com/Kyino-Pan/agents-director/releases/tag/v0.2.2).
Requires Orca **>=1.4.260 / Host API 1.10**.

- Dim Unobserved hatching in both themes and its legend. Message paths, arrowheads
  and mailbox markers have stronger contrast, with distinct send-attempt,
  send-accepted and mailbox-received stages. Working keeps its bamboo green;
  short intervals keep their measured duration.
- Pan the timeline with responsive horizontal gestures, paced at up to 60 frames
  per second. Retained observations move immediately while viewport requests
  coalesce; unloaded history stays empty until its matching snapshot arrives.
- Allocate the segment budget to the visible time window so older history does
  not crowd out its measured states and communication endpoints. Stale viewport
  replies cannot replace a newer view.
- Preserve verified local coordination under lane, segment and receipt limits,
  including retained message endpoints and safely framed mailbox batches.
- Resolve a verified new terminal launch's creation time through its public
  workspace history when the global history list misses it. Keep both spawn
  endpoints together within the remaining lane budget, including idle endpoints.
- Keep the live label steady during background refreshes, and use pushpin icons
  for pinned projects and terminals.

The public APIs, requested permissions and engine minimum are unchanged from
v0.2.2. Collection remains limited to publicly observed states and verified local
terminal tool receipts. Missing execution history, native-chat/remote coordination,
conversation bodies and per-terminal memory are not reconstructed. No directory
listing or maintainer endorsement is implied; [review issue #11](https://github.com/Kyino-Pan/agents-director/issues/11)
remains open.

## v0.2.1

- Reclaim old recorder keys by name and discard uncommitted public chunks before
  saving. A failed write preserves the last committed public snapshot, including
  large v0.2.0 snapshots. View preferences survive the upgrade.
- Enable terminal navigation when Orca supplies the original workspace, provider
  and public session ID. The context menu and Command/Ctrl-click explain missing
  identity. The worker verifies ownership again before focus or resume.

## v0.2.0

Address [review issue #11](https://github.com/Kyino-Pan/agents-director/issues/11)
by replacing private Orca file/database access and internal runtime calls with the
public plugin API. Require Orca >=1.4.260 / host API 1.10.

- Discover workspaces/projects, collect live agent states and public session summaries.
- Verify ownership before focusing a terminal or resuming a saved session in its original workspace.
- Bound observations; leave history and offline gaps unknown.
- Keep a separate public-only cache and retain existing view preferences.
- Remove internal database readers, runtime credentials/RPC, CLI launcher and bundle.
- Remove custom profile directories and report unavailable conversation text,
  orchestration relationships and process memory. Browser preview uses synthetic data.
- Request explicit public workspace, history, focus and saved-resume permissions.

Publishing a release and requesting official re-review are separate actions. The
maintainers' issue remains open until they accept the implementation. See
`docs/reference.md` for checks and validation limits.
