# Access boundaries

Agents Director uses Orca's `trusted-worker` execution profile. It has the current user's
Node.js access to the host. The checks below reduce accidental access and reject hostile input;
they do **not** sandbox compromised plugin code or defend against another process with the
same user's privileges. The plugin still asks for Full access.

- Source databases open read-only with `query_only`, untrusted schemas and no extension loading.
- Data files must resolve inside an explicitly selected source directory. Path-prefix siblings,
  traversal and symlinks escaping the permitted roots are refused; only regular files are read.
- Only local Codex/Claude JSONL transcripts are parsed. The default source also permits the
  providers' standard transcript directories (`sessions`, `archived_sessions`, `projects`).
  Imported data cannot nominate arbitrary files elsewhere on this computer. Custom transcript
  locations outside these roots are unavailable; there is no extra-directory grant setting.
- Status JSON is capped at 32 MiB before reading; profile indexes and runtime metadata at
  64 KiB. Transcript reads are bounded to 32 MiB per pass.
- Recent user inputs are a read-only, on-demand detail request accepting only a canonical agent ID.
  The worker resolves a directly recorded Codex/Claude transcript or unique native Chat journal;
  pane/dispatch reuse and parent-child relationships do not authorize another conversation's text.
  Existing file-root checks also apply to input reads. A single active read and a single four-second
  result cache bound global demand. Transcript reads include their header within a 32 MiB budget;
  records over 1 MiB are skipped and tails are labelled. Native journal reads cap at 2,000 records/
  items and 16 MiB JSON, refuse unsupported formats, and apply only the current published epoch.
  Results contain at most three 4,000-character texts, with explicit truncation. Inputs never enter
  persistent history, snapshots or plugin storage; panel rendering uses textContent, never Markdown
  or HTML. No new host capability, external network access, shell command or arbitrary panel path is added.
- Terminal navigation only runs the CLI bundled next to Orca's worker entry using the current
  executable. There is no PATH fallback. Only exact `show`, `list` and `switch` argument shapes
  are admitted. Child processes receive a small environment allowlist, excluding loader flags,
  profile overrides, PATH and ambient API credentials. The launcher does not use a shell.
- Conversation navigation/resume and on-demand memory sampling read ephemeral runtime credentials.
  Metadata must be a regular file in the source root and private to the current user on Unix. Only the socket
  matching Orca's PID/runtime naming is accepted: no TCP, WebSocket, remote pipe or object-form
  socket address. Unix socket ownership and directory write permissions are checked before
  each request. Windows uses the exact local named pipe; filesystem mode checks are Unix-only.
- Resume adds only the `status.get` and `worktree.show` reads and two identity-scoped runtime
  mutations: `terminal.ensureAgentSession` (saved local native harness identity, background
  presentation) and `agentSession.reveal` (existing Orca Chat session ID). Their parameter shapes
  are checked by one shared provider/key/metadata policy; commands, prompts, panel-supplied paths, account environment and fresh-agent
  creation are rejected. These calls can create a terminal process for a saved conversation or
  republish a saved Chat tab. They do not add a Host API capability; the existing full-access
  trusted worker authenticates to the same-user runtime. This is a real mutation boundary, not
  read-only navigation, and runs only for the explicit Open or resume gesture.
- Resume requires recorded identity and local host provenance, a matching current workspace
  record and an existing directory. Remote and WSL resume routes are refused; Windows CLI
  resume is refused when the hook identity cannot distinguish its original route. Internal
  subagents without a standalone identity cannot be promoted to terminal agents.
- Native terminal resume retains only recorded transcript path, working directory and effort
  metadata alongside identity. Pi/Prime Agent require an absolute saved-file locator and match
  ownership by file as well as ID; OMP uses its recorded locator or ID. Paths are never derived
  from IDs. The host owns launch settings and commands; old launch args/env are not copied.
  A recorded working directory differing from the workspace is refused because the current
  native ensure RPC cannot carry it. Malformed metadata is refused instead of silently dropped.
- RPC methods are allowlisted, responses must match both request and runtime identity, total
  response bytes are capped at 1 MiB and requests time out. Tokens are never sent to the panel,
  stored in the history cache or logged.
- Memory sampling uses only the local `diagnostics.memory` and workspace-scoped `terminal.list`
  RPCs, at most once per 30 seconds. It adds no process scanner, file roots or capabilities.
  Only current local terminal matches receive ephemeral memory values.
- The panel supplies an agent ID, not a command or target address. Navigation resolves it
  against the live tab conversation identity and fresh terminal inventory. Historical pane
  ownership alone cannot authorize switching. Resume attempts are guarded across panels and
  uncertain mutations are not automatically retried. Imported sources cannot navigate.

The plugin stores a rolling history cache, including short coordination-message excerpts, in
Orca's plugin-owned storage. It has no analytics or telemetry. It does not request terminal
input, fresh-agent launching, notifications or secret-storage Host API capabilities. Saved
conversation resume nevertheless can launch a process through the runtime as described above.
Removing the worker's full host access while retaining cross-project history and navigation
requires additional restricted APIs from Orca.
