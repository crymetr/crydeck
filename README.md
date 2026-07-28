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

Phase 0: PTY spike. Throwaway code in `src/spike.js` and `src-tauri/src/pty.rs`.
It answers one question and nothing else: does a Tauri + ConPTY + xterm.js
terminal feel as good as Windows Terminal under load? If it does not, the Tauri
plan is dead and we say so before building any UI on top of it.

## Dev

```powershell
pnpm install
pnpm tauri dev
```
