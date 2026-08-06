# Changelog

All notable changes to CryDeck. Format loosely follows Keep a Changelog;
versions are git tags.

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

