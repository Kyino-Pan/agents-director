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
  mutations: `terminal.ensureAgentSession` (saved local Codex/Claude identity, background
  presentation) and `agentSession.reveal` (existing Orca Chat session ID). Their parameter shapes
  are checked; commands, prompts, arbitrary transcript paths, account environment and fresh-agent
  creation are rejected. These calls can create a terminal process for a saved conversation or
  republish a saved Chat tab. They do not add a Host API capability; the existing full-access
  trusted worker authenticates to the same-user runtime. This is a real mutation boundary, not
  read-only navigation, and runs only for the explicit Open or resume gesture.
- Resume requires recorded identity and local host provenance, a matching current workspace
  record and an existing directory. Remote and WSL resume routes are refused; Windows CLI
  resume is refused when the hook identity cannot distinguish its original route. Internal
  subagents without a standalone identity cannot be promoted to terminal agents.
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
