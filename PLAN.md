# Claude Cockpit — build plan

A minimal desktop shell around the Claude Code CLI. Not an IDE: no LSP, no autocomplete,
no debugger, no extension host. That omission is the entire reason it can stay light.

## Layout (Sait's spec)

```
┌─ tabs: one per session, each own cwd ───────────────────────────────┐
├──────────────┬──────────────────────────────┬──────────────────────┤
│ file tree    │ terminal (Claude Code TUI)   │ preview (read-only)  │
│ lazy, git    │ real PTY via ConPTY          │ selected file        │
│ dirty marks  │                              │                      │
├──────────────┴──────────────────────────────┴──────────────────────┤
│ status: context % | 5h + weekly limits | model | effort | cost      │
└─────────────────────────────────────────────────────────────────────┘
```

Interactions:
- single click file  -> preview in right pane
- double click file  -> OS default app (docx -> Word, xlsx -> Excel)
- double click folder -> new Explorer window

## Decisions locked

| Question | Answer |
|---|---|
| Preview pane | Read-only viewer. No editing. Claude does all writes. |
| Session isolation | Tab = working directory + Claude process. No git worktrees (yet). |
| Scope vs VS Code | Sits alongside. VS Code stays for heavy jobs. Never build an editor. |
| Stack | Tauri 2 (Rust core + system WebView2) + xterm.js + portable-pty |

## Stack rationale

- Tauri 2: ~40-60MB idle, <10MB binary, uses WebView2 already on Windows 11.
- Electron would be ~200-300MB idle and 250MB installed. Faster to build (node-pty),
  but violates the one hard requirement.
- Node server + browser tab: worst of both. Awkward lifecycle, no real desktop
  integration, no resource win once Node + a browser are counted.
- Cost of Tauri: one-time rustup + MSVC build tools install (~1.5GB). No Rust on this
  machine today.

## Status bar data source

Claude Code's `statusLine` hook gets JSON on stdin per render:

```
model.display_name, effort.level, context_window.used_percentage,
cost.total_cost_usd, rate_limits.five_hour.{used_percentage,resets_at},
session_id, session_name, workspace.current_dir, exceeds_200k_tokens, fast_mode
```

Everything the bottom bar needs. Plan: install a shim script that forwards a copy of
this JSON to the app, keyed by a per-tab random ID passed in an inherited env var
(`COCKPIT_TAB_ID`) — cwd is NOT an identity, two tabs can share a folder.

Hard rule: the shim must PROXY, not replace. If a statusLine is already configured,
read stdin once, forward a copy, invoke the original with identical stdin, return its
stdout and exit code unchanged. Native status bar ships opt-in.

Transcript JSONL is a fallback only (undocumented, delayed, no authoritative rate limits).

## Phases (each independently usable)

### Phase 0 — spikes (throwaway, go/no-go gate)
- Install rustup + MSVC build tools.
- PTY torture spike: resize, 100MB of output, unicode/emoji, alternate screen buffer,
  paste, Ctrl-C, tab switching. Must feel indistinguishable from Windows Terminal.
- Benchmark batched binary IPC before any UI exists.
- **If the terminal is not solid, stop here.** Everything later just decorates it.

### Phase 1 — better than a bare terminal
One Claude PTY in a chosen cwd. Correct resize/input/paste/alt-screen/shutdown.
Lazy file tree beside it. Double-click opens in OS default app. Remembers last cwd.
OUT: tabs, preview, watching, git, status bar, settings.

### Phase 2 — sessions
Tabs. Per-tab cwd/env/PTY. Close/kill semantics. Windows Job Object per session so
closing a tab kills the whole process tree (node.exe, MCP servers, tool subprocesses).
Terminal state preserved across tab switches — never recreate the xterm instance.
Cap at 6 active sessions.

### Phase 3 — preview + change awareness
One shared read-only CodeMirror 6 instance (NOT Monaco), showing the active tab's file.
Lazy filesystem watching. Refresh only visible nodes. Refuse binaries and huge files.

### Phase 4 — git decoration
Repo discovery, cached `git status --porcelain=v2 -z` debounced 1-2s per repo (not per
FS event), dirty highlighting in the tree. No staging, no commits, no SCM panel.

### Phase 5 — native status bar
The opt-in proxy shim, tab-ID mapping, stale-data indicator, existing-statusLine
compatibility, transcript fallback.

Only then: persisted layout, themes, search, installer.

## Engineering rules (from Codex review)

- PTY output: dedicated Rust thread, batch 8-16ms or 16-64KB, bounded queue, binary
  Tauri channels. Never one JSON event per chunk. Scrollback capped 5-10k lines.
- Resize: debounce 30-50ms, ignore zero/duplicate sizes, active terminal only, resend
  after tab activation and DPI change.
- Ctrl-C is the byte `0x03`, not `GenerateConsoleCtrlEvent`. Process-tree kill is a
  separate explicit action.
- Paste: implement Ctrl-Shift-V yourself, use bracketed paste, OSC 52 clipboard writes
  off by default. Treat terminal-emitted URLs and clipboard requests as untrusted.
- Unicode width will never be perfect. Bundle a known monospace font, use xterm's
  Unicode 11 addon, accept occasional redraw defects.
- Never watch `C:\dev` recursively. Watch the workspace only. Drop `.git`,
  `node_modules`, `target`, `dist`, `build`, `.next`, coverage, caches before allocating
  any UI message. Coalesce 100-300ms. On kernel buffer overflow, rescan visible nodes.
- Shared across sessions: the WebView, one FS service per workspace root, one git cache
  per repo, one status broker, one preview component, icon/metadata caches.
  Per session: only the Claude process, PTY, terminal buffer, cwd/env, status snapshot.

## Top 5 project killers

| Failure | Countermeasure |
|---|---|
| Terminal "almost works" but corrupts or freezes under load | Phase 0 torture spike before any UI |
| IPC can't handle fast output | Benchmark batched binary transport first |
| Session processes leak after tab close | Job Object from day one |
| Status shim overwrites the user's config or breaks quoting | Opt-in + proxy, never silently replace settings.json |
| Feature creep into a real IDE | Frozen scope: terminal, tree, preview, git decoration, status. Explicitly rejected: editing, SCM operations, extensions, session resurrection |

## Prior art

- **Claudette** (utensils.io/claudette) — Tauri 2 + Rust + React, MIT, real PTY per
  agent, git worktree per session, live context meter. Closest thing that exists.
  Has tabs + terminal, lacks file tree, preview pane, OS-open.
- **CloudCLI / siteboon claudecodeui** — web UI, file tree with live editing, session
  management, plugin tabs. Web-first, so heavier and no OS integration.
- **Nimbalyst** — kanban session management, worktree isolation, iOS companion.
- **Claude Desktop (official)** — Code tab, parallel sessions with git isolation,
  drag-and-drop panes, visual diff review.
