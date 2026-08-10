# Changelog

All notable changes to CryDeck. Format loosely follows Keep a Changelog;
versions are git tags.

## v0.13.0 - 2026-08-10

### Added
- **Render an HTML file.** Selecting an .html/.htm file in the tree now shows a **Render ↗** button in the preview header; it loads the file itself (file://) into the App pane so you see the rendered page, with relative CSS/JS/images resolving, no server needed. The code view is still there. To view a whole project, run its dev server in the session and the App pane picks up the localhost URL automatically.

## v0.12.0 - 2026-08-10

### Changed
- **Four-state tab badge.** The session dot now distinguishes waiting-on-you from finished: blue (working), amber (done), red pulse (blocked — Claude rang for a permission or a question), or no dot (idle). Previously a bell and a quiet finish both showed the same amber, so you couldn't tell an urgent prompt from a completed run at a glance. A red badge also raises a desktop notification.

## v0.11.1 - 2026-08-10

### Added
- **Features panel in the About card (ⓘ).** A plain-language list of everything CryDeck can do — sessions, first-run setup, Remote Control, the crydeck CLI, shortcuts, notifications, and more — so nothing has to be discovered by accident. Sits beside the Changelog button.

## v0.11.0 - 2026-08-10

### Added
- **Find file (Ctrl+Shift+P).** Fuzzy finder over the repo's git-tracked files; picking one inserts `@path` into the active session so you can reference it to Claude.
- **Search in files (Ctrl+Shift+F).** `git grep` across the repo; picking a hit inserts `@file`.
- **Open in VS Code (Ctrl+Shift+E).** Opens the active session's folder in VS Code.
- **Prompt library (Ctrl+Shift+K).** Save prompts you reuse and type them into a session with one pick.
- **Desktop notifications.** When a background session goes quiet (Claude finished or is waiting on you), CryDeck raises a notification so you can look away and get pulled back.
- Shortcuts are listed in the About card (ⓘ). They use Ctrl+Shift+* on purpose, so they never clobber the shell's own Ctrl+P / Ctrl+E / Ctrl+K.

## v0.10.0 - 2026-08-09

### Added
- **Session orchestration (`crydeck` CLI).** Any session can now drive the others through a small command on its PATH, backed by loopback-only, token-authed gateway routes:
  - `crydeck spawn <folder> [prompt...]` opens a new session and optionally types its first message. This is what lets you open a NEW session from your phone: steer a dispatcher session over Remote Control and tell it to spawn.
  - `crydeck list` shows open sessions with their ids.
  - `crydeck read <id> [tailLines]` reads another session's recent output (ANSI-stripped) for cross-terminal context.
  - `crydeck send <id> <text...>` types a message into another session.
  This is the Windows-native stand-in for Claude Code's cross-session messaging (which is macOS/Linux only), and it needs no new open ports. See ROADMAP.md for where this is going.

## v0.9.7 - 2026-08-07

### Added
- Start with Windows, on by default. CryDeck registers itself to launch at login on first run; a "Start CryDeck when Windows starts" checkbox in the About card (ⓘ) turns it off or back on, and that choice sticks across restarts.

## v0.9.6 - 2026-08-07

### Fixed
- Black/dead terminal on machines without PowerShell 7: when pwsh is absent CryDeck fell back to Windows PowerShell 5.1, which renders an empty non-responsive terminal under ConPTY on some boxes (a dev machine with pwsh installed never hit it). First-run setup now installs PowerShell 7 too (winget, or the direct MSI from GitHub), env_check reports pwsh, and the Welcome prompt lists it among the prerequisites. Restart CryDeck once after install so new terminals use pwsh.

## v0.9.5 - 2026-08-07

### Fixed
- The real first-run culprit: the Claude Code installer drops claude.exe in %USERPROFILE%\.local\bin but does not add it to PATH (it only prints a manual note), so setup installed Claude yet Get-Command never found it and the run looked like it failed. Setup now persists that directory to the user PATH itself, so Claude resolves immediately and on every later launch.

## v0.9.4 - 2026-08-07

### Fixed
- Auto-update could not deliver the 0.9.3 setup fixes: they were re-released under the same 0.9.3 version, so the updater saw "already 0.9.3" and never pulled them. Shipped as 0.9.4 so the update actually reaches installed copies.
- Added trace lines around the first-run flow (env check result, Install accept/decline, setup session start, script typed) so a stuck setup is diagnosable from the log instead of invisible.

## v0.9.3 - 2026-08-07

### Fixed
- First-run setup silently did nothing on machines without winget (common on stock/home Windows): the install steps were chained so a missing winget swallowed the rest. Setup is now self-correcting and talks the whole way through — Git falls back from winget to the direct git-for-windows installer (resolved via the GitHub API so it never 404s on a version bump), failures print a clear message, and every step announces what it is doing so a stuck one is visible. It also enables TLS 1.2 first, since the setup tab lands in Windows PowerShell 5.1 on a fresh machine and 5.1 otherwise fails the GitHub/installer fetches with an SSL error.
- First-run setup silently did nothing when a tab was already open at the Projects folder — which happens on every launch, since CryDeck restores open tabs. Clicking Install now always opens a dedicated setup tab instead of skipping. This was the main "click Install, nothing happens" cause.
- First-run setup is now loud instead of silent: on a slow connection a silent step looked frozen, so every step announces itself, the Git download shows a live progress bar, the installer runs visibly, and a final summary prints the installed git/claude versions or names exactly what is still missing. Claude only launches when it truly resolves.

## v0.9.2 - 2026-08-06

### Fixed
- Empty-state buttons ("Open a folder", "Start in my Projects folder") were unclickable: the positioned #termhost stacked above them and ate the clicks.

## v0.9.1 - 2026-08-06

### Added
- First-run setup: CryDeck checks for Git and Claude Code on launch and, with one click, installs whatever is missing inside a normal terminal tab (winget for Git, official installer for Claude Code), then flows straight into Claude's login. Fully installed machines skip all of it.
- Beginner onboarding: the empty state explains sessions and offers "Start in my Projects folder" (auto-creates %USERPROFILE%\Projects); first-run setup lands there too. README gained a from-zero Getting Started section.
- About card: tiny ⓘ on the tab bar — version, GitHub, cryme.tr, Buy me a coffee, and an inline changelog viewer.

## v0.9.0 - 2026-08-06

### Added
- Auto-update: CryDeck checks GitHub Releases on launch, asks before installing, and relaunches into the new version (tauri-plugin-updater, signed artifacts).
- Distribution: CI now builds and publishes a signed NSIS installer (CryDeck_x64-setup.exe) plus updater manifest (latest.json) on every version tag.

## v0.8.3 - 2026-08-06

### Fixed
- Close actually closes now: window.destroy() was silently denied because the capability set lacked core:window:allow-destroy. v0.8.2's dialog appeared but the Close button did nothing.

## v0.8.2 - 2026-08-05

### Fixed
- Shells no longer inherit Claude Code session markers or TERM=dumb when CryDeck is launched from inside a Claude session: pty spawn scrubs CLAUDE* / color-suppressing env vars and sets TERM=xterm-256color + COLORTERM=truecolor. Fixes colorless terminal and "Transcript saving is off" warnings.
- The X button works again: window.confirm() is a no-op in Tauri's webview, so the close confirmation silently vetoed every close. Replaced with an in-page dialog (session-cap alert too).
- Resizing no longer strobes the terminal blank: lost WebGL contexts are recreated immediately with a forced repaint instead of after 500ms.

## v0.8.1 - 2026-08-05

### Fixed
- Paste with plain Ctrl+V (Ctrl+Shift+V still works) and copy with Ctrl+C when text is selected, in the main terminal and the extra shells under the preview. Right-clicking a terminal now pastes directly.

## v0.8.0 - 2026-07-29

### Added
- Review queue (community-requested): a fourth preview mode grouping Claude's edits under the prompt that caused them (via a UserPromptSubmit hook). Unreviewed counts per task and on the Review button, click-through to diffs, per-task mark-all-reviewed. Shares the amber/green read-state with the tree.

## v0.7.0 - 2026-07-29

### Added
- Session continuity: restored tabs relaunch Claude with --continue, so closing the app no longer loses conversations, and closing the window now asks first when sessions are live.
- Auto-continue scheduler: right-click a tab to schedule a 'continue' after the rate-limit reset (from statusLine resets_at) or a custom delay. Always user-set; countdown in the status bar, clock icon on the tab.

## v0.6.2 - 2026-07-29

### Fixed
- UI froze the moment a preview opened: webview-creating commands ran synchronously on the main thread and deadlocked against WebView2 creation. All preview commands are now async (off the main thread), and rect syncing is debounced.

## v0.6.1 - 2026-07-29

### Fixed
- Spawned processes (git, taskkill) no longer flash console windows (CREATE_NO_WINDOW).
- File view renders content immediately; the diff attaches asynchronously instead of blocking with a loading state.

## v0.6.0 — 2026-07-29

### Added
- **Interactive preview**: the App pane is now a real Tauri child webview
  instead of an iframe, with a script injected into every page it loads.
- **Element select** (🎯): click any element in the previewed app; a
  description (selector, text, position) is typed into that session's Claude
  prompt so it knows exactly where to look.
- **Annotations** (✏️): draw numbered boxes on the previewed page, hit Send,
  and Claude gets a screenshot of the annotated region plus the coordinates
  and nearest selectors, ready to Read.
- **Preview page tabs**: multiple pages per session in the App pane.
- **Extra terminals** (⌨): up to three plain pwsh terminals per session in a
  collapsible strip under the preview.

### Changed
- Preview screenshots are captured via GDI so annotation overlays are
  included in what Claude sees.

## v0.5.0 — 2026-07-29

### Added
- Diff viewer in the File pane: dirty files get a Content|Diff switch;
  files Claude just changed default to the diff.
- Tab attention badges: blue pulse while a background session produces
  output, amber once it goes quiet or rings the terminal bell.

## v0.4.0 — 2026-07-29

### Added
- Kill-on-close Job Objects per session: closing a tab (or crashing the app)
  reaps the whole claude/node/MCP process tree.
- Git dirty marks in the tree (blue dot) alongside Claude change marks.
- GitHub Actions workflow: tag push builds and releases `crydeck.exe`.

### Fixed
- ConPTY reader threads no longer leak on session close
  (`CancelSynchronousIo`).

## v0.3.0 — 2026-07-29

### Added
- Read-state marks: amber = Claude changed it, green = you opened it since,
  re-edit flips back to amber.
- Sessions launch with `claude --remote-control "<folder>"` for phone pickup.
- First detected dev server auto-loads in the App pane.

### Fixed
- F5 / Ctrl+R / WebView context-menu reload no longer tears down terminals;
  orphaned shells are reaped at boot if a reload happens anyway.
- Terminal no longer blanks on aggressive window resizes (WebGL context
  recreation + forced repaint).

## v0.2.x — 2026-07-28/29 (as "Cockpit")

### Added
- Full e2e build on the Design v2 architecture: session tabs, lazy file tree
  with hook-driven change highlighting, File/App/Feed preview, status bar
  from the statusLine hook, loopback hook gateway, pwsh sessions with
  PSReadLine predictions.
- Real-time tree: per-session watcher over root + expanded dirs only.
- `app.exe <folder>` opens a session at that folder.

### Fixed
- Hook commands rewritten as single shell-agnostic `curl.exe` lines installed
  into user settings: Claude Code on Windows executes hooks via git-bash and
  ignores hooks from `--settings` files, so `.cmd` shims died silently.
- Log file moved out of workspaces (watcher feedback loop).

## v0.1.0 — 2026-07-28 (Phase 0 spike, as "Cockpit")

- Tauri + ConPTY + xterm.js viability spike: batched binary IPC, WebGL
  rendering, Unicode grapheme handling, throughput and memory measurements.
  Findings and defects recorded in PLAN.md.

