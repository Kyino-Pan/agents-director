# Agents Director

See your Orca agents across projects in one timeline. Follow live terminal states,
inspect past session summaries, and return to a conversation without switching
between every workspace.

## Features

- **Agent overview:** named lanes grouped by project, with Orca harness icons.
- **Observed history:** retain seven days of states collected through Orca's public
  plugin API. Session history supplies titles and counts; earlier execution states
  and offline gaps stay unknown.
- **Coordination:** solid curves connect verified parent and child sessions. Dashed arrows show accepted mail and confirmed mailbox retrieval. A diamond marks mail retrieved with an unknown sender. [Live capture and coverage](docs/reference.md#coordination)
- **Focus by time:** zoom, pan or select a range, filter lanes and pause the view.
- **Quick navigation:** Command-click on macOS, Ctrl-click elsewhere, or use the
  context menu to focus a matching terminal or resume its saved session in the
  original workspace. Orca controls how and whether a session can resume.
- **Flexible layout:** open an editor tab or sidebar panel. Time window and lane
  order preferences persist between sessions.

Version 0.2.0 replaces the private-file collector with public APIs to address
[Orca's review feedback](https://github.com/Kyino-Pan/agents-director/issues/11).
Orca exposes live tool hooks on supported local terminals. The collector can recognize
specific send, question, reply, mailbox check and new-agent receipts there. Earlier coordination,
conversation text and process memory remain unavailable. Old screenshots
and the cover artwork illustrate the earlier collector and are not current feature
claims. The old recorder cache and custom data-directory setting are not imported;
public collection starts a new history, alongside the public session summaries.

## Install

Requires **Orca ≥1.4.260 / plugin Host API 1.10** on desktop.
Open **Settings → Plugins → Add plugin → From a Git URL…** and enter:

```text
https://github.com/Kyino-Pan/agents-director#main
```

Approve the access request, then open **tab-bar + → Agents Director** or the
**Agents Director** sidebar panel. No build step is needed.

Requested capabilities: read agents, workspaces and session history; focus
workspaces/terminals; resume saved agents; and use the plugin's own storage.
Orca also asks for the two agent tool hooks used to observe local coordination.
Resuming happens only after a navigation action. Collection does not start agents.

Free, MIT-licensed community plugin. Uses documented host APIs and its own storage;
no direct access to Orca's files, databases, runtime credentials or internal RPC.
No analytics or telemetry. Not an official Orca product.

See the [reference](docs/reference.md) for controls, coverage, development and checks,
and [security notes](docs/security.md) for access details.
