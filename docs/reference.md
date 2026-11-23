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
  The lane label uses state intervals in the selected window. “Last: Done” gives
  the last observed state when coverage ends before the right edge. If later intervals
  in the window were omitted, “Last retained: Done” identifies the last available
  observation. “Messages only” means the window contains communication but no
  available execution interval.
  Select an individual gap to see its coverage.
- Use the window slider, duration presets, From/To controls, pan or modified wheel
  to inspect a period from five minutes to seven days.
- Pause view freezes inspection while collection continues.
- Hide short tasks filters only reliably finished executions below three minutes.
  Incomplete history remains visible. Session summaries alone never prove a short task.
- Sort by recent activity or choose Shorter links to group related lanes.
- Right-click → Data sources shows collection errors, truncation and coverage.
- Layout preferences use the plugin's own storage.

Command-click on macOS or Ctrl-click elsewhere opens the selected session. The
context menu offers the same **Open or resume terminal** action. Both controls
explain which public identity is missing when the session cannot be opened. Navigation first
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
The snapshot includes up to 160 lanes, 4,000 segments across those lanes and
600 messages. When demand exceeds 4,000 segments, the snapshot first reserves the
existing intervals covering both endpoints at the plotted message time, the
receiver at retrieval, and each lane's latest interval. Sparse lanes keep
their full history when it fits. Dense lanes share the budget and fill their
remaining places with recent intervals. A window overlapping omitted intervals keeps
the lane visible, even with no messages. “History limited” appears when such
a window contains no retained state interval. The recorder bounds
points and messages at 5,000 each.

**Other coverage limits.** There is no public coordination history feed. Conversation
bodies, recent user inputs, process memory and private execution metadata are unavailable. The recent-input section explains that
conversation text is unavailable. No terminal screen scraping is used to infer it.
No CLI subprocess, internal RPC, runtime token, database or provider transcript is
read by the worker.

## Coordination

Orca 1.4.265 was tested with local Codex 0.171.0 on macOS. A disposable Orca
profile hosted the plugin and test terminals. One Codex session ran
`orca agent launch --agent codex --surface terminal --prompt ... --json`, then
`orca orchestration send --to term_… --subject ... --body ... --json`. The receiver
ran the ordinary `orca orchestration check --terminal term_…`. The public tool
hooks reported `agent: codex`, `tool: Bash`, `terminalId`, `callId`, an
`input.command` string and, after the call, a string `output`. The JSON send
receipt contained `ok: true` and `result.messageId`. The receiver's default text
header contained the same ID. Neither `terminal.send` nor `agent.prompt.before`
was needed to establish these relationships.

The screenshot shows two real local Codex terminals on an isolated Orca desktop.
The lower session launched the upper session and then sent it a test message.
The solid curve marks the launch. The dotted vertical line with an open arrowhead
marks the message retrieved by the upper session. The capture used the normal
Agents Director custom editor at five-minute zoom and `orca plugin shot`.

![Native Orca panel showing local test messages and new sessions](../assets/local-coordination.png)

- A dotted send attempt can appear while a directly addressed call is in progress.
  It expires in memory. A successful single-message receipt records acceptance.
  An ordinary mailbox check reporting that ID confirms retrieval at the receiver.
  The arrow stays at the send receipt time. Message details show both lane states
  at that time and the receiver's state at retrieval. A larger open circle marks
  an endpoint without an observed state. Each horizontal bar shows its measured
  duration, even below one pixel. Zoom in to inspect a short interval or select
  its hit target for the exact duration. Grouped arrows use the first message's
  position. Select a group member to inspect its own times and observations.
  A diamond denotes a confirmed mailbox input when the sender is unobserved.
- Terminal launch receipts from `agent launch --json`, `worktree create --agent --json`
  and a ready `orchestration worker-start` can supply a child handle. Worker starts
  support JSON and the default concise receipt with explicit `mode=terminal`.
  A solid curve requires the first observed public session identity and a public
  session creation time at or after launch began. Worker starts accept
  `--spec`, `--spec-file` and `--task`,
  including a task title and a base branch for a new worktree. An attached
  existing terminal (`--terminal`) can establish a dispatch address.
  It cannot create a parent relationship. `agent resume` is excluded.
- Sender and receiver identities come from the live terminal inventory and status
  changes. An observed ready dispatch can resolve `dispatch:…` to the same live
  terminal session. For a bot, run, implicit mailbox or unmapped dispatch, a matching
  send and receiver check ID can join the two observed terminals. Names, task titles
  and time proximity never supply an endpoint. A send into native chat or bot
  Home Chat without a matching public terminal receipt leaves the recipient
  unresolved. Alias and attached-dispatch cases have regression coverage.
- A direct `ask --question ... --json` with a pending message ID or a successful
  `reply --id ... --body/--body-file ...` supplies the sender and acceptance time.
  A reply uses its newly returned ID. The question can be missing. Only a consuming
  check for the returned ID supplies the recipient and retrieval time. Until then
  these receipts stay in memory. A run-scoped check requires an explicit terminal
  matching the hook's own terminal.
- Parsing accepts a direct `orca` or `"$ORCA_CLI_BIN_DIR/orca"` command, plain send/reply receipts or JSON,
  concise worker-start receipts, and ordinary check text (first message) or JSON
  (up to 200). Compound shells, redirects, substitutions, failed calls,
  cross-server sends, replay commands, ambiguous ownership and group sends are
  excluded. Both tool phases must have
  matching call and terminal IDs. An unresolved receipt stays in memory for up
  to two minutes, with 512 entries per pending collection. A direct accepted
  arrow can be confirmed later while retained in the seven-day cache.
- If two sessions report successful sends with the same message ID, the recorder
  removes the sender and keeps a conflict flag on that ID within the message
  cache's existing retention and size limits. A verified retrieval keeps its
  receiver and check time. The panel shows the receiver-only diamond after that
  check, including after a cache reload.
- A tool hook is available on supported local terminal agents while the plugin
  runs. A command invoked in a plain shell, a native chat or on SSH/WSL does not
  give the plugin the same hook pair. For those surfaces, broader coverage needs
  a public event that carries a message ID, both stable session identities and
  the acceptance or delivery stage.

### Local terminal reproduction

On Orca 1.4.265 and Codex 0.171.0, a disposable desktop loaded the baseline
(`df03861`) and candidate collectors together. Two real terminal sessions
exercised two dispatches in the same Run. To reproduce in a test profile, use
the coordinator and worker's own terminal tools for each exchange.

1. From the coordinator terminal run `"$ORCA_CLI_BIN_DIR/orca" orchestration worker-start --spec-file <fixture> --task-title first --worktree new-child --name <name> --base-branch main --agent codex --json`.
2. Have the worker ask one question using `orca orchestration ask --question <text> --json`.
   Consume it in the coordinator with the supplied `check --run <run> --terminal <own-terminal>`.
   Reply using `reply --id <question-id> --body-file <fixture> --json`.
   Have the worker consume the reply and send its normal `worker_done`. Consume the completion.
3. Create another task with `task-create --spec-file <fixture> --task-title second --json`.
   Attach it with `worker-start --task <id> --terminal <same-worker-terminal> --json`.
   Repeat the exchange using plain `reply --id <question-id> --body <text>`.
4. Compare `activity.snapshot` with `hideShortTasks: false` on both collectors.
   Count the unique IDs from the Run and two Dispatch inboxes. A message is
   missing when its ID has no snapshot row. Count parent links separately.

| Observed in the same two dispatches   | Baseline | Candidate |
| ------------------------------------- | -------: | --------: |
| Parent links for one fresh session    |        0 |         1 |
| Additional parent links on attachment |        0 |         0 |
| Messages with both session endpoints  |        0 |         6 |
| Receiver-only messages                |        2 |         0 |
| Missing messages out of six           |        4 |         0 |

Both questions and both completions went from worker to coordinator. Both replies
went in the reverse direction. Each reply had a new ID that matched the worker's
check. The observed acceptance-to-retrieval intervals spanned 5.0–7.4 seconds.
The CLI fenced a run-scoped consuming check from a different bound terminal and
from an unbound terminal. The bound caller then retrieved the waiting message.
The final parser also rejects an explicit non-terminal launch mode. Replaying
the two captured terminal-mode receipts and six message IDs with the final
guards produced the same endpoints and stages. A separate native repeat reached
`start_unknown` before any exchange and produced no parent link. It contributes
no successful dispatches or messages to the table.

In this macOS terminal profile `"$ORCA_CLI_COMMAND" --version` failed, while
`"$ORCA_CLI_BIN_DIR/orca"` ran the bundled CLI. A nested `sh -c` send returned
a real message ID and the outer shell hook supplied no direct send evidence.
`worker-start --item` was refused in an ordinary terminal. The option belongs
to a bot's own chat. These tests measured local terminal sessions only. The
availability of terminal hooks for a different client, or the cause of a
receiver-only row in an existing installation, cannot be inferred from these counts.

### Working intervals

Working bars use bamboo green in both host themes.
The timeline joins working observations on the same lane when the gap from one
end to the next start is strictly below 30,000 ms. Chains can include short
waiting, blocked and unknown intervals. A completion ends a chain, including
a zero-duration completion. Each interval keeps its observed state and source in
the detail view. A leading or trailing gap stays unknown. Display duration is
considered before hiding completed tasks shorter than three minutes.

## Cache and upgrade

Own storage keeps compressed observations under `activity-public-v1`, with an
alternating chunk generation and an atomic head update. It saves about every
15 seconds and on orderly shutdown; offline intervals stay unknown after restore.
The encoded budget is 1.8 MiB; decompression is bounded to 32 MiB. Storage failures
appear under Data sources. An over-budget save keeps the previous generation.

Before staging a generation the worker lists its own keys and deletes obsolete
0.1.x recorder heads/chunks by name, plus public chunks outside the committed
head. It never reads or imports private-source history. Two full encoded generations
(1,843,200 bytes each) and their pretty-printed JSON keys/values together occupy
under 3.53 MiB of the host's 5 MiB quota. If unrelated keys occupy the remaining
space, the host can refuse the save. The next attempt uses the stored head to
recover even when the previous worker stopped mid-write.

Storage checks use only the public key list and head.
After observing existing keys, the recorder defers writes if that storage disappears
or the head and key list disagree. Live collection continues until the reads recover.
On a new installation, two empty observations on separate refreshes start normal
recording, usually after five seconds. Until then, observations are in memory.
Orca 1.4.260 can report the same empty list
and absent head for a persistent filesystem read error on cold start. Its public API
provides no first-install or storage-health signal. If an error such as `ESTALE`
persists through the first snapshot write, the host can replace the unreadable file.
[Orca 1.4.260 KV implementation](https://github.com/stablyai/orca/blob/3330a89fa30edfd154901546f368ab4d6329962c/src/main/plugins/storage/plugin-storage-store.ts#L36-L97)

Existing window and
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
