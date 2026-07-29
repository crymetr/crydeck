# CryDeck

A lightweight Windows desktop shell for [Claude Code](https://claude.com/claude-code).
Tabs of Claude sessions, a live file tree, and a preview pane where you can
actually use what Claude builds.

Not an IDE. No editor, no LSP, no debugger, no extension host. Claude does the
writing; CryDeck is where you watch, steer, and try the result. That omission
is the entire reason it stays light (~250MB working set, single small binary).

![CryDeck: Claude editing a project on the left, the resulting app running live in the preview pane](docs/screenshot.png)

```
┌─ tabs: one Claude Code session per tab, each its own folder ────────┐
├──────────────┬──────────────────────────────┬──────────────────────┤
│ file tree    │ terminal (Claude Code TUI)   │ preview              │
│ live, unread │ real PTY via ConPTY          │ File | App | Feed    │
│ marks        │ pwsh 7 + predictions         │ live localhost apps  │
├──────────────┴──────────────────────────────┴──────────────────────┤
│ status: model | effort | context % | 5h/weekly limits | cost       │
└─────────────────────────────────────────────────────────────────────┘
```

## What it does

- **Tabs are sessions.** One working directory + one Claude Code process per
  tab (cap 6), restored on relaunch **with their conversations** (via
  `--continue`). Sessions launch with Remote Control on, so your phone can
  pick any of them up. Background tabs show a blue pulse while their Claude
  works and an amber dot when it finishes or needs you.
- **The tree is live and knows what Claude touched.** Files Claude edits glow
  amber; open one and it turns green (seen); a re-edit flips it back; blue
  dots mark uncommitted git changes. Powered by Claude Code's own hook
  events, not filesystem guessing. The watcher tracks only the root +
  expanded folders, so a tab on a huge parent dir is cheap, and a project
  folder Claude scaffolds appears the moment it lands.
- **Preview pane, three modes.** *File*: read-only viewer (code, rendered
  markdown, images) with a **Content|Diff switch**; files Claude just changed
  default to the diff. *App*: a real embedded webview with page tabs; the
  first dev server the session starts loads automatically and stays alive
  across tab switches. *Feed*: everything Claude produced, newest first.
- **Point at things, literally.** Element select (🎯): click any element in
  the running app and its selector, text and position are typed into Claude's
  prompt. Annotations (✏️): draw numbered boxes on the page, hit Send, and
  Claude gets the coordinates plus a screenshot with your boxes on it.
- **Extra terminals** (⌨): up to three plain pwsh terminals per session in a
  strip under the preview.
- **Auto-continue after rate limits.** Right-click a tab and schedule a
  `continue` for one minute after the limit resets (CryDeck knows the reset
  time from the statusLine hook) or any custom delay. Always set by you,
  never automatic; countdown in the status bar.
- **OS integration.** Double-click opens files in their default app (docx to
  Word, xlsx to Excel) and folders in Explorer. Right-click a folder to spin
  it up as a new session.
- **Status bar** from Claude Code's statusLine hook: model, effort, context %,
  5h/weekly rate limits, session cost. The Claude TUI status line inside the
  terminal shows a compact version of the same.

## How the hook wiring works (please read before installing)

On first launch CryDeck merges two entries into `~/.claude/settings.json`:
a `statusLine` command and a `PostToolUse` hook. Both are a single direct
`curl.exe` call to a loopback-only gateway (fixed port range 48620-48639,
per-install token). Your original settings file is backed up once as
`settings.json.pre-cockpit`; an existing statusLine you wrote yourself is
never replaced; entries are never duplicated. Outside CryDeck the hooks fail
in milliseconds (connection refused) and Claude carries on unaffected.

Why not `--settings`? Claude Code on Windows executes hook commands through
git-bash and does not trust hooks from flag-supplied settings files. The
shell-agnostic single-line curl form is the only shape that survives cmd,
bash and PowerShell alike. The scars are documented in PLAN.md.

## Requirements

- Windows 11 (WebView2, ConPTY)
- [Claude Code](https://claude.com/claude-code) CLI on PATH
- PowerShell 7 (`pwsh`) recommended for inline prediction ghost text;
  falls back to Windows PowerShell
- To build: Rust (MSVC toolchain) + pnpm

## Build and run

```powershell
pnpm install
pnpm tauri build --no-bundle
# binary lands in src-tauri/target/release/
```

Run it bare, or pass a folder to open a session there:

```powershell
crydeck.exe C:\dev\myproject
```

Dev mode: `pnpm tauri dev`. Always build releases through the Tauri CLI — a
raw `cargo build` produces a binary that points at a dev server that is not
running (PLAN.md, Phase 0 defect 4).

## Known limitations

- Windows-only by design (ConPTY, cmd/Explorer integration).
- Tab close kills the process tree via `taskkill /T`; Job Objects are planned.
- A session's shell is pwsh; Claude launches automatically in each new tab.
- Frame-blocking headers (rare on dev servers) will keep a site out of the
  App pane; use the open-in-browser button instead.

## License

MIT
