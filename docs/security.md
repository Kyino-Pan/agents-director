# Access and data handling

Agents Director uses Orca's documented plugin host API and its own storage.
The shipped worker imports only its own modules and Node's `zlib` for bounded cache
compression. It does not open Orca data files, read runtime credentials, connect to
internal RPC, spawn subprocesses, read provider transcripts or scrape terminal text.
The old collector, private runtime client, vendored process launcher and generated
CLI bundle have been removed.

## Requested access

| Capability        | Use                                                        |
| ----------------- | ---------------------------------------------------------- |
| `agent:read`      | Current terminal agents and `agent.status.changed`         |
| `workspace:read`  | Workspace/project discovery and fresh ownership checks     |
| `history:read`    | Past session summaries and navigation identity checks      |
| `workspace:write` | Focus a terminal and its workspace following a user action |
| `agent:launch`    | Resume an explicitly selected saved conversation           |
| `storage:own`     | Seven-day public observations and view preferences         |

These are real host permissions and Orca asks the user to approve them. The worker
remains trusted Node code; a capability list does not sandbox compromised code.
No secrets, terminal read/send or external network capabilities are requested.

Collection and refresh are read-only apart from plugin-owned storage. Only the
`activity.navigate` handler calls `agent.resume` or `terminal.focus`. It requires an
exact recorded public provider/session/workspace identity, then rechecks public
workspace and agent lists. If no terminal matches, it verifies history in that
original workspace before requesting resume. The host enforces provider, account,
route and launch rules. Failures propagate; there is no retry through a shell,
alternative identity, workspace or private method. Duplicate concurrent requests
for one agent share one navigation operation.

Orca asks separately for the `agent.tool.before` and `agent.tool.after` hooks.
The hooks can expose tool arguments and outputs across supported terminal agents.
Handlers return without rewriting, denying, awaiting or running a command.
Only recognized direct Orca routing actions are parsed, in memory. No command,
body, subject, prompt, environment, raw output or tool call ID is saved by these
handlers. Successful messages retain a message ID, session endpoints when known,
stage and times. A verified child retains its parent ID and observed launch time.

Titles, public identities, summary counts, workspace/project metadata and
bounded observed states are also cached. A public title can include the start of a first
message, as Orca documents. Conversation bodies and recent inputs are unavailable;
no content is collected by guessing a transcript path. Text in the panel is rendered
with `textContent`. Bundled harness artwork is the only injected SVG markup.

The public cache uses a separate storage namespace. The worker deletes obsolete private-source
recorder keys by name without reading their values. Cache data is
bounded to 1.8 MiB compressed and 32 MiB decoded. Snapshot budgets and seven-day
retention also apply. The worker has no telemetry and makes no external requests.
The synthetic browser preview reads only repository assets.

Tests mock all resume and focus calls. Passing automated checks is not an official
listing approval; the maintainers must review the replacement version themselves.
