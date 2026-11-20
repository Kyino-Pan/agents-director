# v0.2.1 prepared change

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
