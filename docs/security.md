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
- Chat navigation reads ephemeral runtime credentials only on demand. Metadata must be a
  regular file in the source root and private to the current user on Unix. Only the socket
  matching Orca's PID/runtime naming is accepted: no TCP, WebSocket, remote pipe or object-form
  socket address. Unix socket ownership and directory write permissions are checked before
  each request. Windows uses the exact local named pipe; filesystem mode checks are Unix-only.
- RPC methods are allowlisted, responses must match both request and runtime identity, total
  response bytes are capped at 1 MiB and requests time out. Tokens are never sent to the panel,
  stored in the history cache or logged.
- The panel supplies an agent ID, not a command or target address. Navigation resolves it
  against recorded ownership and the live host inventory. Imported sources cannot navigate.

The plugin stores a rolling history cache, including short coordination-message excerpts, in
Orca's plugin-owned storage. It has no analytics or telemetry. It does not request terminal
input, agent launching, notifications or secret-storage capabilities. Removing the worker's
full host access while retaining cross-project history and navigation requires additional
restricted APIs from Orca.
