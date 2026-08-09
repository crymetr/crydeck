# CryDeck Roadmap

Where CryDeck is going, and why. Grounded in a competitive scan of the current
crop of AI-agent terminals (VelaTerm, Termic, herdr, Superset, NodeTerm,
Maestri, Terminal Graph, Orca) done Aug 2026.

## What we protect (the differentiators)

- **Open source** (MIT) with signed auto-update. Half the field is closed.
- **Zero-setup on a fresh PC** — one click installs PowerShell 7 + Git + Claude
  Code and logs you in. Nobody else does the from-nothing bootstrap.
- **Windows-native**, lightweight (Tauri), the hook/gateway architecture, and
  the File/App/Feed preview pane.

## What we deliberately do NOT build

- A canvas / node-graph UI. Maestri, NodeTerm, Terminal Graph, and October all
  chase the infinite-canvas metaphor. It is heavy and does not fit CryDeck's
  tab model. Stay tabbed; differentiate elsewhere.

## Phases

### Phase 1 — Orchestration core (flagship) — DONE (v0.10.0)

A `crydeck` session-control CLI backed by loopback gateway routes (token-auth,
never exposed off localhost). Any Claude session can call it via Bash:

- `crydeck spawn <folder> [--prompt "..."]` — open a new session, optionally
  seed its first message. This is what lets you open a NEW session from your
  phone: you steer a dispatcher session over Remote Control and tell it to spawn.
- `crydeck list` — the open sessions (the ListAgents equivalent).
- `crydeck read <id> [--tail N]` — read another session's recent output. This is
  NodeTerm-style "context links", and the Windows-safe stand-in for Claude's
  cross-session messaging (which is macOS/Linux only).
- `crydeck send <id> "text"` — type a message into another session. The
  Windows-native stand-in for SendMessage.

Delivers three things at once: open-a-session-from-phone, cross-terminal context
sharing, and orchestration ("you are the orchestrator, spawn a frontend
session"). Does not depend on Claude's native cross-session feature, so it works
on native Windows today. If that feature ever lands on Windows, it layers on top.

### Phase 2 — Daily quick wins — DONE (v0.11.0)

- Fuzzy file finder (Cmd+P, backed by `git ls-files`).
- Find-in-files (backed by `git grep`).
- Open in external editor (VS Code) for the current folder.
- Desktop notifications when a background session flips to needs-you.
- Prompt library: save and re-run frequent prompts into a session.

Low effort, self-contained, brings the daily experience level with Termic/Superset.

### Phase 3 — Agent state awareness

Upgrade the tab badge from two states (busy / attention) to herdr's four:
idle / working / blocked (waiting on you) / done. Pairs with Phase 2
notifications so "blocked" is what actually pings you.

### Phase 4 — Worktree parallel isolation (big)

Each session in its own git worktree, so parallel agents don't collide. The
market standard (Termic, Superset, Orca, herdr). Builds on the existing diff
viewer. High effort; do it when parallel work is real.

### Phase 5 — SSH remote sessions (biggest, deferred)

Manage a remote host's terminals as if local (VelaTerm / Orca's edge). Its own
project.

## Sequencing

Phase 1 → 2 → 3, then stop and use it. Phases 4-5 when a real need appears.
Phase 1 is the differentiation (Windows-safe orchestration + open source);
Phases 2-3 bring daily UX to parity without touching the zero-setup edge.
