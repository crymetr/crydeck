# Cockpit

A minimal desktop shell around the Claude Code CLI.

Not an IDE. No language server, no autocomplete, no debugger, no extension host.
That omission is the entire reason it can stay light.

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

- single click a file, it previews on the right
- double click a file, it opens in the OS default app (docx to Word, xlsx to Excel)
- double click a folder, a new Explorer window opens there

Stack: Tauri 2 (Rust core + system WebView2), xterm.js, portable-pty.

See `PLAN.md` for the phase breakdown and the engineering rules that came out of
the architecture review.

## Status

v0.2.0, full e2e build on the Design v2 architecture (see PLAN.md):

- Tabs, one Claude session per tab, own cwd, cap 6, restored on relaunch
- Lazy file tree, changed-file highlighting fed by Claude Code PostToolUse hooks
- Preview pane with File / App / Feed modes; App is a live iframe per session,
  Feed collects files Claude edits and localhost URLs it mentions
- Status bar from the statusLine hook: model, effort, context %, limits, cost
- Sessions run pwsh 7 with PSReadLine predictions; `claude` is wrapped so the
  hook settings ride along via --settings, user settings.json never touched
- `app.exe <folder>` opens a session at that folder

Not yet done: Job Objects on tab close (taskkill /T fallback in place), git
dirty decoration, ConPTY EOF reader-thread reclaim, human feel test.

Phase 0 spike is archived in `src/spike.js`.

## Dev

```powershell
pnpm install
pnpm tauri dev
```
