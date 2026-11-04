# Agents Director reference

[Back to overview](../README.md)

## Install

Requires **Orca >=1.4.246 / plugin Host API 1.2**.
Open **Settings → Plugins → Add plugin → From a Git URL…** and enter:

```text
https://github.com/Kyino-Pan/orca-agent-activity#main
```

The release includes its terminal-navigation bundle; installation needs no build or npm install.
This free, MIT-licensed community plugin has no analytics or telemetry.
It is not an official Orca product.

Review and approve the access request Orca displays. The worker reads
local source logs using Node, with private storage, settings and `agent:read` access. No terminal
input, notifications, secrets or network access are requested through the host API.

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
- **Go to terminal:** right-click an agent lane or segment → **Go to terminal**, or Command-click
  on macOS / Ctrl-click on Windows and Linux. Ordinary clicks still inspect activity. Shift+F10
  opens the same menu from the keyboard. Closed or disconnected terminals show a reason.
- **Pause view:** freezes the displayed snapshot for inspection; collection continues. Resume shows
  the latest snapshot. The time-scale slider or Ctrl/Command-wheel adjusts the visible window; horizontal wheel or Shift-wheel pans it. Ordinary vertical scrolling moves through the page and tracks. Project bands with recorded communication are placed near one another. Only agents with observed activity, a completion or spawn, or a coordination message in the selected window are shown; an old completed or unobserved state alone does not keep a lane visible. The From and To fields select local-time endpoints within the retained history. Nearby messages between the same agents collapse into a count; select it to inspect each message.

Project bands use the saved project catalog and project-group membership, including folder workspaces; unresolvable membership is shown as unavailable. Workspace remains a secondary identity. Agent lanes show Orca harness icons and a short session identifier. Native Chat pane events
join their saved conversation records, including older Codex/Claude handle formats.
Agent lanes prefer recorded names: user-renamed conversations, saved conversation names,
orchestration task names, then terminal titles. Lower-priority observations never replace a
known name. Unnamed history keeps its provider/ID fallback. Canonical IDs stay stable when names
change; available Orca/provider session IDs, pane keys, terminal handles and orchestration IDs
remain attached for inspection, search and terminal navigation.

Host API 1.2 has no terminal navigation method, so the trusted worker uses the desktop's own
CLI through the shared process launcher. It checks terminal identity before `terminal switch`,
never sends terminal input, and only reports success when Orca confirms navigation. A stale
handle can be refreshed by exact workspace/pane only while the recorded conversation still
owns that pane. Navigation is disabled for imported data directories and browser previews;
those cannot safely identify a terminal on the current desktop. Host-registered remote
terminals follow the same CLI path; no new SSH connection is made by this plugin.

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
  child-agent lifecycle blocks. Provider-neutral journal records cover native Chat sessions.
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
