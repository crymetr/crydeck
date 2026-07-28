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
- **claude-command-center** (nubbymong, MIT) — Electron + xterm.js + node-pty +
  React/Zustand + better-sqlite3. Closest technical relative. Multi-session with
  per-session isolated home dirs, tokenomics dashboard, transcript viewer,
  2000+ tests, CI green on Windows. Explicitly has **no file tree and no preview
  pane**: "the app treats sessions as first-class objects rather than files."
  Steal: its status pipeline (statusLine hook -> **HTTP gateway**, plus
  background transcript indexing, plus LiteLLM pricing JSON cached 24h).
- **Nimbalyst** (MIT) — Electron + React + Monaco + Lexical + Excalidraw, embeds
  **ghostty** as its terminal rather than building one. Much larger scope
  (Kanban sessions, mobile companions, CF Worker sync). Not a model for us.

Of the prior art, only Claudette is Tauri; the rest are Electron. None of them
offers a file tree + preview + OS-open. That gap is the whole reason to build.

---

## Phase 0 results (2026-07-28)

Toolchain: rustup 1.29 / rustc 1.97.1 stable-msvc + VS BuildTools 2022 (MSVC
14.44, Windows SDK 10.0.26100). Neither was present beforehand.

**Terminal works.** Unicode11 width tables load, WebGL renderer active, PTY
spawns at 106x36, input and output both flow.

**Throughput, 100MB dump through a real ConPTY:**

```
88.1MB in 54.9s = 1.6MB/s | 4497 ipc msgs (avg 20KB) | max write queue 3
reader thread: read() 55.3s | send() 0.3s
```

The IPC bridge costs **0.5%** of wall clock. The reader thread lives entirely
inside `read()`, so ConPTY paces us at roughly 20KB per 12ms tick. Even with
zero rendering the dump would take ~55s. Tauri is not the bottleneck, and
`node-pty` under Electron drives the same ConPTY API, so Electron would hit the
identical ceiling.

Max queue depth of 3 means xterm never backlogged and input stays responsive
during a flood. 1.6MB/s is ~20k lines/sec of terminal text, far beyond anything
Claude Code's TUI emits. A rare 10MB log cat costs ~6s.

**Do not compare against `Measure-Command { cmd /c type }` in Windows Terminal.**
That reported 100MB in 1.8s, but it times cmd.exe writing into the pty, not the
terminal finishing its render. It is not an end-to-end number and the 40x gap it
implies is an artifact.

### Defects found

1. **ConPTY never signals EOF when the child exits.** The master only reports EOF
   when the pseudoconsole is closed. Reading until `Ok(0)` hangs forever, so
   every closed session leaks a parked reader thread. Shutdown order must be:
   kill process tree -> drop master -> reader unblocks. **Not yet fixed.**
2. **Never inject escape sequences into the render path.** The first alt-screen
   test wrote `?1049h` straight to the output channel. ConPTY models the screen
   and emits diffs against that model, so writing behind its back desyncs the two
   and everything after renders as glitch. Alt-screen sequences must originate
   from a real process inside the PTY. Fixed.
3. **`CreateProcessW` does no PATHEXT resolution.** `claude` on PATH is an
   extensionless npm shell script and spawning it directly fails with os error
   193. Same trap awaits `npm`, `pnpm`, `wrangler`. Any spawn feature must go
   through shell resolution. Fixed in the spike by typing into the running shell.
4. **Raw `cargo build` never embeds the frontend, in debug OR release.** Only the
   Tauri CLI wires up `frontendDist`, so a plain `cargo build --release` produces
   a binary that still points at `devUrl` and shows an Edge "localhost refused to
   connect" page with no vite server running. Symptom is easy to misread as a
   working app, and any measurement taken against it is measuring an error page.
   Always build releases with `pnpm tauri build` (add `--no-bundle` to skip
   installer generation).

### Memory (release, real UI, one session)

```
                          working set    private
WebView2 (6 processes)       399 MB       251 MB
session shell (pwsh+conhost)  82 MB        52 MB
app.exe (Rust core)           27 MB         5 MB
                          ----------    ---------
total                        508 MB       308 MB
```

Binary 8.63MB, release build 57s incremental.

The session's own PowerShell is 52MB and you pay that in any terminal, so
Cockpit's own cost is roughly **256MB private**. Of that, the Rust core is 5MB
and WebView2 is everything else. A bare WebView2 rendering an error page already
costs 212MB private, so xterm + WebGL adds only ~40MB on top of the floor.

**Tauri's advertised 40-60MB does not survive a real app.** The Rust core really
is nearly free, but the WebView is not, and Electron would swap WebView2 for
bundled Chromium at similar or worse cost plus ~250MB of install. Conclusion:
Tauri is marginally better than Electron here, not dramatically. It was worth
staying on, not worth switching to. Expect ~250MB plus roughly 50MB per extra
session, since additional sessions add a shell and a terminal buffer rather than
another browser.

### Open

- Human feel test of the terminal under load.
- ConPTY EOF thread leak (defect 1), scheduled for Phase 2 with the Job Objects.
