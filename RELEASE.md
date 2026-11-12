# v0.1.7 prepared change

Saved terminal resume supports all 26 audited Orca-native resumable harnesses through the
existing saved-session host authority. Cursor/Antigravity conversation IDs, Pi/Prime Agent
session-file identity, OMP locators and recorded effort are preserved through collection and
cache restore. Commands, launch settings and ownership remain host-controlled, and capabilities
are unchanged. Missing required identity, uncertain owners, unsupported execution routes and
recorded working directories the native RPC cannot preserve remain refused. Independent
acceptance and release publication are separate from this preparation.

# v0.1.0 release checks

Prepared 2026-11-03 from the local Orca Agent Activity implementation at
`35beff1ef23ec525b6ae29f02a5a16907ca2fd17`.

## Scope

- Rolling seven-day observed activity, project bands, named lanes and spawn/message relationships.
- Conversation-handoff identity attribution and failed-launch deduplication.
- Terminal navigation, compact inspection, persistent window/order preferences and smooth sorting.
- Empty time ranges retain the timeline so users can pan back.
- Standalone package with committed CLI bundle, source, licenses and synthetic screenshots.

## Gates

Run `npm run build`, `npm run lint`, `npm run format:check`, `npm test`,
`orca plugin validate .`, `orca plugin check .` and `orca plugin test .` before tagging.
The test suite has 54 tests. GitHub CI repeats the build, checks that the committed bundle
matches, runs lint/format and tests on Linux/Node 22. Release tags point at a checked commit.
A committed archive is also checked for manifest validity and bundle import without npm install.

HTML panels are not rendered by `orca plugin check`; browser tests cover explicit desktop
and narrow viewports. Native macOS plugin rendering was checked during feature development
on Orca 1.4.246. Native Windows/Linux apps and remote hosts are not end-to-end verified.
Unknown/missing source observations remain unknown; the plugin cannot recover absent logs.

## Similar work

Checked the GitHub `orca-plugin` topic, agent-activity repository search and official/community
catalog metadata on 2026-11-03. The closest match was
[Activity Calendar](https://github.com/bhojanibilal24/orca-activity-calendar), which provides
calendar/history, parallel-time, recap and CSV views. Its documented features did not include
spawn/message relationship edges, handoff source attribution or short-link lane ordering.
[Agent Pool](https://github.com/VictorStochero/orca-agent-pool) focuses on quota and test queues.
This search is bounded and does not establish exclusivity.

## Distribution

Install the tagged Git URL from the README. The GitHub repository carries the `orca-plugin`
topic for discovery; directory indexing is separate from publishing a GitHub release.
No private activity databases, logs, cache, real screenshots or credentials are distributed.
