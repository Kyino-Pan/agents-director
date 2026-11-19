# Agents Director reference

## Requirements and installation

Orca **>=1.4.260**, plugin Host API **1.10**, desktop. The version floor covers
`agent.listSessions`, the expanded `agent.resume`, public session identities,
workspace/project listing and terminal focus. Workspace-scoped `agents.list` requires
host API 1.10; detecting the older method by name alone is insufficient. See Orca's
[host API reference](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-host-api.md).

Install `https://github.com/Kyino-Pan/agents-director#main` through
Settings → Plugins → Add plugin → From a Git URL. Open the Agents Director panel
or create an Agents Director editor from the tab-bar + menu. New permissions must
be approved in Orca before updating from 0.1.x.

## Timeline and controls

Lanes use public session titles, harness labels and workspace/project membership.
Task titles from `agents.list` provide fallback names. A terminal with no public
session identity can show observed states, but cannot be resumed by this plugin.

- Search by name, identity or workspace.
- Select a lane or state for details; copy its identity from the detail panel.
- Use the window slider, duration presets, From/To controls, pan or modified wheel
  to inspect a period from five minutes to seven days.
- Pause view freezes inspection while collection continues.
- Hide short tasks filters only reliably finished executions below three minutes.
  Incomplete history remains visible. Session summaries alone never prove a short task.
- Sort by recent activity. Shorter links and relation rendering remain compatible
  with synthetic fixtures; the public API supplies no new relationship observations.
- Right-click → Data sources shows collection errors, truncation and coverage.
- Layout preferences use the plugin's own storage.

Command-click on macOS or Ctrl-click elsewhere opens the selected session. The
context menu offers the same **Open or resume terminal** action. Navigation first
rechecks workspace membership and current agent ownership through public APIs.
It focuses an exact matching terminal; otherwise it verifies the original session
in that workspace's public history and calls `agent.resume`, then `terminal.focus`.
Ambiguous ownership, missing identities/workspaces, unsupported providers and host
denials are reported. There is no shell or internal-runtime fallback. Restoring a
Chat-specific tab is not part of this API: saved sessions resume through Orca's
terminal workflow. The host controls provider, account, execution host and launch
policy. A cancelled focus reports failure even if a resume already started.

## Data and coverage

The worker calls only:

| Method                                            | Purpose                                          |
| ------------------------------------------------- | ------------------------------------------------ |
| `workspace.list({ includeStatus: true })`         | Discover public workspace ids and names          |
| `project.list({})`                                | Resolve project names on the matching host       |
| `agents.list({ workspaceId })`                    | Observe each workspace's current terminal agents |
| `agent.listSessions({ limit: 200 })`              | Read newest session summaries every 30 seconds   |
| `agent.listSessions({ workspaceId, limit: 200 })` | Verify a saved session on a navigation action    |
| `agent.resume({ workspaceId, agent, sessionId })` | Resume after a navigation action                 |
| `terminal.focus({ terminalId })`                  | Focus a freshly matched or resumed terminal      |

Current inventories refresh every five seconds, at most four workspace requests
at a time. `agent.status.changed` updates identities already known from public
results. `workspaceListId` is preferred over the older event's internal address;
unknown identities wait for the next public inventory. An event arriving during an
older inventory response wins for that terminal. Event state is not extended by
merely reading a panel snapshot.

Every state interval is bounded by observations. Missing terminals, failed reads,
worker downtime and poll gaps over 15 seconds stop continuity; they never imply
continued work or completion. Session `createdAt`, `updatedAt` and `running` are
metadata, not execution intervals. Before public collection, history is unknown.
The public session list omits subagent transcripts and Antigravity IDE conversations.
The plugin cannot restore historical states it never observed. Remote coverage is
limited to what the connected Orca host exposes through these APIs; there are no
custom profile directories, copied databases or direct remote-file reads.

Session history is bounded to the newest 200 sessions across workspaces, and the
host may truncate workspace/project lists. Source details report these limits.
The panel retains its existing budgets (160 lanes, 4,000 segments, 600 messages),
and the recorder bounds points/messages at 5,000 each. These are coverage limits,
not evidence that omitted sessions did not run.

**Unavailable through the public API:** orchestration messages/parent-child links,
conversation bodies and recent user inputs, process memory, original command
arguments and private execution metadata. The recent-input section explains that
conversation text is unavailable. No terminal screen scraping is used to infer it.
No CLI subprocess, internal RPC, runtime token, database or provider transcript is
read by the worker.

## Cache and upgrade

Own storage keeps compressed observations under `activity-public-v1`, with an
alternating chunk generation and an atomic head update. It saves about every
15 seconds and on orderly shutdown; offline intervals stay unknown after restore.
The encoded budget is 1.8 MiB; decompression is bounded to 32 MiB. Storage failures
appear under Data sources. An over-budget save keeps the previous generation.

0.1.x data under `activity-v1` stays untouched and is not read or imported. Old
identities and routes came from a different collection source; importing them
would mix private-file observations with public identities. Existing window and
order preferences remain in the same plugin-owned storage. `dataDirectories` was
removed and no longer selects any filesystem roots. Versions before 0.2.0, legacy
screenshots and cover artwork describe the earlier implementation.

## Development and validation

Node **>=22.13** is sufficient. In this checkout:

```sh
npm ci
npm run lint
npm run format:check
npm test
orca plugin validate . --json
orca plugin check . --json
ORCA_BACKGROUND_LAUNCH=1 orca plugin test . --json
orca plugin inspect /path/to/clean-package --json
```

Run `plugin inspect` on a clean package containing only versioned files: a development
checkout with `node_modules` can fail its symlink check. Validation and tests above
run in the development checkout.

No runtime bundle or build step is needed. The icon-generation script uses esbuild
and React only as development dependencies; see NOTICE.md.

`npm run preview` starts a loopback browser preview with **synthetic data only**.
It reads the plugin's own UI assets, not Orca data. It cannot navigate or resume
real agents. Old `--data-dir` arguments are no longer supported.

Node tests use a strict fake public host, covering identity changes, missing and
failed observations, event/inventory races, history truncation, ownership checks,
resume/focus errors and storage restore. Resume/focus calls are mocked. Browser
tests cover rendering and controls at desktop and narrow widths. Plugin validation
and checks do not prove live provider resume or all native platforms. No checks
should start or resume a real conversation without a deliberate navigation action.

The `validate-plugin` CI job runs Orca's official `validate:plugin` against a clean
plugin checkout using the pinned v1.4.260 source revision and Node 24. It follows the
official catalog CI's JavaScript-only dependency setup (`--ignore-scripts`), without
building or launching Electron. The main test job still exercises Node 22. Update
the validator revision deliberately when adopting newer host APIs.
