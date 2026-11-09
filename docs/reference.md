# Agents Director reference

[Back to overview](../README.md)

## Install

Requires **Orca >=1.4.246 / plugin Host API 1.2**.
Open **Settings → Plugins → Add plugin → From a Git URL…** and enter:

```text
https://github.com/Kyino-Pan/agents-director#main
```

The release includes its terminal-navigation bundle; installation needs no build or npm install.
This free, MIT-licensed community plugin has no analytics or telemetry.
It is not an official Orca product.

Review and approve the access request Orca displays. The worker reads
local source logs using Node, with private storage, settings and `agent:read` access. No terminal
input, notifications, secrets or network access are requested through the host API. An explicit
Open or resume action can start a saved CLI conversation through the trusted worker runtime;
it can also reopen an existing saved Chat tab.

- **Full overview:** tab-bar **+ → Agents Director**, or choose the new-file command **Agents Director**.
  This opens an `.orca-activity` document in the main editor area, where the view can be split.
- **Sidebar:** open the **Agents Director** plugin panel.
- **Inspect:** click an agent, state segment or message arrow to open a floating detail view;
  Close or Escape dismisses it. The timeline fills the remaining viewport height, and inspection
  does not shrink it. Arrow controls support keyboard selection.
- **Lane order:** agents within each project default to most recently observed activity first.
  **Shorter links** toggles ordering to minimize the total vertical span of spawn and message
  connections in the selected window, counting each message even when arrows are visually bundled.
  Cross-project connections contribute without moving project bands. Equal costs prefer activity
  order, then stable agent ID. Up to 14 lanes per project use an exact optimizer; larger groups use
  six bounded improvement passes and never increase the cost over activity order. The toggle stays
  selected during live refresh, search and zoom. Window duration and lane-order mode are saved
  in Orca plugin storage and restored when a panel or editor is reopened; the first view defaults
  to 24 hours and activity order. Reopening follows the latest time rather than a stale panned date.
  Reordered lanes, activity bars and connection endpoints move together over 200ms; system
  reduced-motion preferences disable the transition.
- During wheel panning or zooming, existing lane positions stay fixed. New agents append at the
  bottom so their activity, spawn links and messages appear immediately as the timeline moves.
  After 180ms without wheel input, lanes filter, regroup and smoothly reorder for the final window.
  Panning into an empty interval keeps the timeline and scroll area available, with an in-chart
  message, so you can scroll back without resetting the window.
- **Data sources:** right-click the view → **Data sources**. The coverage details open on demand.
- **Open or resume Chat / terminal:** right-click an agent lane or segment → **Open or resume Chat** for native
  sessions or **Open or resume terminal** for CLI agents, or Command-click
  on macOS / Ctrl-click on Windows and Linux. Ordinary clicks still inspect activity. Shift+F10
  opens the same menu from the keyboard. A current owner is preferred; eligible closed conversations reopen in their original workspace.
  Unverified exits, missing identities and unsupported routes show a reason without starting anything.
- **Terminal memory:** the name's right edge shows current terminal-and-child-process memory,
  sampled at most every 30 seconds while the view requests updates. Units are MiB/GiB; hover
  for the metric and sample time. macOS uses footprint, Linux RSS and Windows working set,
  as reported by Orca diagnostics. This measures the terminal subtree, not an individual model.
  Only exact current local terminal matches qualify. Historical agents, native Chats, internal
  subagents without their own terminal, remote terminals and imported sources show no value.
  Samples expire after 60 seconds and never enter the history cache. Pause freezes these values
  along with the view; panning history still shows current memory for a currently owned terminal.
- **Pause view:** freezes the displayed snapshot for inspection; collection continues. Resume shows
  the latest snapshot. The time-scale slider or Ctrl/Command-wheel adjusts the visible window; horizontal wheel or Shift-wheel pans it. Ordinary vertical scrolling moves through the page and tracks. Project bands with recorded communication are placed near one another. Only agents with observed activity, a completion or spawn, or a coordination message in the selected window are shown; an old completed or unobserved state alone does not keep a lane visible. The From and To fields select local-time endpoints within the retained history. Nearby messages between the same agents collapse into a count; select it to inspect each message.

Project bands use the saved project catalog and project-group membership, including folder workspaces; unresolvable membership is shown as unavailable. Workspace remains a secondary identity. Agent lanes show Orca harness icons and a short session identifier. Native Chat pane events
join their saved conversation records, including older Codex/Claude handle formats.
Agent lanes prefer recorded names: user-renamed conversations, saved conversation names,
orchestration task names, then terminal titles. Lower-priority observations never replace a
known name. Unnamed history keeps its provider/ID fallback. Canonical IDs stay stable when names
change; available Orca/provider session IDs, pane keys, terminal handles and orchestration IDs
remain attached for inspection, search and terminal navigation.

Host API 1.2 has no terminal navigation or resume method, so the trusted worker uses the
desktop's bundled CLI and authenticated local runtime socket. Before `terminal switch`, it
joins the live workspace tab's provider/session identity to a fresh terminal inventory, checks
the handle and checks conversation ownership again. Historical pane aliases alone never
prove ownership: a reused pane cannot open its successor by mistake. Navigation is disabled
for imported data directories and browser previews.

A closed local Codex or Claude CLI conversation with an explicitly recorded provider session,
workspace and local execution host can use `terminal.ensureAgentSession` with `resumeOrigin:
saved`. Orca owns resume command construction and conversation claims; the plugin sends no
shell command, fresh-agent request or prompt. The original workspace must still resolve on
the original host and its directory must exist. A missing or incomplete inventory, ambiguous
owner or disconnected process is refused rather than treated as closed. Host capability checks
must advertise both host authority and saved-resume support. Remote CLI resume is refused;
Windows CLI resume is refused because hook records do not establish the original native/WSL
route. Existing verifiable terminal navigation still works on those platforms and hosts.
Internal model subagents without a separate recorded standalone identity cannot be resumed.
Other CLI providers currently show an unsupported-provider reason.

Native Chat remains a Chat. An open tab is found by exact Orca session ID. A closed Chat uses
`agentSession.reveal` to republish that same saved conversation, after verifying its recorded
local execution location and the original workspace. It never creates a replacement Chat or
terminal. Remote/WSL or unknown Chat resume routes are refused. Opening either Chat path then
uses `terminal.reveal` with a desktop acknowledgement and host-only `session.tabs.activate`;
both the acknowledgement and selected session must match. These RPCs use the local Unix
socket or Windows named pipe; ephemeral runtime credentials stay in worker memory.

Concurrent navigation requests are blocked across the worker's panels. Once a resume mutation
is sent, another click can navigate a subsequently verified owner, but cannot issue another
resume for that identity during this worker lifetime. This also covers timeouts, lost replies,
refusals and unconfirmed launch ownership: inspect the original workspace in Orca before any
manual recovery. Orca's CLI resume claim additionally prevents duplicate conversation owners.
Restarting the worker clears the local attempt guard; it does not establish that an uncertain
process exited. Navigation/resume calls run only on the explicit gesture, never on refresh.

The worker remains a full-access Node process; its manifest capabilities are not an OS
sandbox. See [access boundaries](security.md) for the enforced application checks and limits.
Imported transcripts must be inside their selected data directory. The default local source
also accepts Codex `sessions`/`archived_sessions` and Claude `projects` under their configuration
directories. References outside those roots appear as unavailable in Data sources.

Coordinator project membership also uses saved terminal tabs and terminal-close records from
the selected profile, so closing a terminal or losing its status cache does not lose a known
project. Conflicting tab ownership stays unresolved. These records establish placement only,
not activity during gaps in state observations.

For older Orca builds, run the log-backed preview from this checkout with **Node >=22.13**:

```sh
node preview.mjs
```

Open the printed loopback URL in Orca's built-in browser or a normal browser. It uses real logs and
refreshes every five seconds, but has no direct plugin status subscription or private recorder
cache. The preview uses the included Orca theme variables. Stop with Ctrl-C. Optional
`--data-dir <absolute-path>` (repeatable) selects data directories; `--port <port>` fixes its port.

## Data and retention

The trusted worker reads, without modifying source databases:

- `agent-session-journal.db`: saved turn endpoints, question/approval observations, and recorded
  child-agent lifecycle blocks. Native Chat history supports legacy inline rows and v5 outcome
  markers with outcome formats 1 and 2. The reader uses the active epoch/generation, applies the
  latest published item values and deletions over any inline prefix, and skips unchanged outcome
  data. Unsupported formats appear as limited source coverage. Open turns stop at their saved
  observation time; they do not prove continuous work up to the present.
- `agent-hooks/last-status.json`: pane/session correlation and recent state observations. This is
  a cache, not a full historical log. Its provider transcript paths select local Codex/Claude
  JSONL files for incremental parsing; the plugin never scans unrelated home-directory sessions.
- `orchestration.db`: saved Runs, dispatch lineage and messages. Messages are matched to agent
  lanes through recorded session, pane, dispatch and terminal addresses. Delivery timestamps are
  not presented as proof that a model understood or acted on a message.
- `agent.status.changed`: live main-agent states (fallback to the pane aggregate on older hosts).
  Live timestamps use local receipt time so remote clock drift does not move the live cursor.

The worker imports logs, then refreshes source files every five seconds while continuing to accept
live events. Turns with known start/end observations become intervals. Assignment alone never
counts as continuous work. Missing endpoints, interrupted collection and unsupported records stay
unknown. Child branches are only drawn when their identity and ancestry are recorded.

Only the last 7 days are returned, including an interval crossing the left boundary. Completed
activity and messages expire after 7 days. The worker saves a chunked, two-generation private
cache roughly every 15 seconds and on orderly shutdown, and rebuilds it from source logs after a
restart. A crash may lose the last unsaved live observations; offline time is not guessed.

Bounded readers process 2,000 journal rows per pass, a 32 MiB tail per referenced transcript, and
up to 3,000 messages / 1,000 dispatches per source. Storage keeps at most 5,000 points and 5,000
messages, with a 1.8 MiB serialized recorder-cache budget. Dense windows can exceed these bounds;
the view explicitly reports partial coverage. Snapshot drawing is capped at 160 lanes, 4,000
segments and 600 messages; message previews are capped at 400 characters.

## Profiles and remote work

The default source is this computer's platform-specific Orca data directory. Set **Plugins →
Agents Director → Orca data directories** to one absolute directory per line for alternate profiles
or read-only mounted/synchronized host copies, then restart the plugin worker. The collector does
not SSH to hosts. Local orchestration records can include remote workers/messages, but their
provider logs are read only when those files are available on the collector host. A copied remote
database must be a coherent SQLite backup, including committed WAL data; copying a live `.db`
alone may omit recent records.

This first version targets desktop plugin frames. Browser-client frames require asset inlining;
the loopback preview works in browsers. The UI supports narrow sidebar/mobile-sized viewports,
but the mobile app does not install or run this desktop worker.

## Development and validation

Use Node >=22.13. From this repository:

```sh
npm ci
npm run build
npx playwright install chromium
ORCA_BACKGROUND_LAUNCH=1 npm test
npm run lint
npm run format:check
orca plugin validate . --json
orca plugin check . --json
ORCA_BACKGROUND_LAUNCH=1 orca plugin test . --json
orca plugin dev load . --json
```

The environment assignment examples above use a POSIX shell. In PowerShell, set
`$env:ORCA_BACKGROUND_LAUNCH = '1'` before running the test commands.

`npm run build` bundles the vendored upstream process launcher into `dist/terminal-cli.mjs`.
Rebuild and commit that file after editing the launcher or `worker/terminal-cli.mjs`.
The complete source and its MIT license are included; see [NOTICE.md](../NOTICE.md).
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing headless Chromium.

Tests cover collection, project ownership, handoff identity, terminal navigation, ordering,
animation, persistence, empty-range recovery, light/dark rendering and narrow layouts.
`orca plugin check` validates HTML panels but does not render them; headless browser tests
provide the rendered checks. Native plugin checks have been performed on macOS with Orca
1.4.246. Windows and Linux native app behavior has not yet been verified.
Resume capabilities and strict RPC parameter contracts were checked against installed Orca
1.4.248. Resume mutations are tested with stubs and private fake runtimes; validation does not
resume real user conversations or reveal desktop windows.
