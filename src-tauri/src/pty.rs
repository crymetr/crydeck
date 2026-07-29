// ConPTY plumbing for the Phase 0 spike.
//
// The design constraints all come from the Codex architecture review:
//   - never send one IPC message per PTY read, batch by time AND size
//   - read on a dedicated OS thread, never block that thread on the WebView
//   - Ctrl-C is the byte 0x03 travelling through the PTY, not a Win32 console event
//   - killing a session must take the whole process tree, not just the direct child

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::{Channel, InvokeResponseBody};

/// Flush the batch once it reaches this many bytes.
const BATCH_BYTES: usize = 32 * 1024;
/// ...or once this much time has passed, whichever comes first.
const BATCH_INTERVAL: Duration = Duration::from_millis(12);
/// Single read syscall size.
const READ_BUF: usize = 64 * 1024;

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Kept so a session can be written to out-of-band later (status lines,
    /// notices). Nothing does that yet, and terminal content must never come
    /// through here: writing behind ConPTY's back desyncs its screen model.
    #[allow(dead_code)]
    output: Channel<InvokeResponseBody>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, PtyState>,
    cmd: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = NativePtySystem::default()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut builder = CommandBuilder::new(&cmd);
    for a in &args {
        builder.arg(a);
    }
    if !cwd.is_empty() {
        builder.cwd(&cwd);
    }

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    // Each tab carries its own identity. cwd is NOT an identity: two tabs are
    // allowed to sit on the same folder. Phase 5's statusLine shim reads this.
    builder.env("COCKPIT_TAB_ID", id.to_string());

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn '{cmd}' failed: {e}"))?;
    let pid = child.process_id();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {e}"))?;

    // Dedicated reader thread. Batches, then hands raw bytes to the WebView.
    // InvokeResponseBody::Raw lands in JS as an ArrayBuffer, so there is no
    // JSON encode/decode of terminal output on the hot path.
    let out = on_output.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        let mut batch: Vec<u8> = Vec::with_capacity(READ_BUF);
        let mut last_flush = Instant::now();

        // Where does the wall clock actually go: waiting on ConPTY, or waiting
        // on the IPC bridge? This decides whether the transport is salvageable.
        let mut read_ns: u128 = 0;
        let mut send_ns: u128 = 0;
        let mut flushes: u64 = 0;
        let mut bytes: u64 = 0;

        loop {
            let t_read = Instant::now();
            let r = reader.read(&mut buf);
            read_ns += t_read.elapsed().as_nanos();

            match r {
                Ok(0) => break, // pty closed
                Ok(n) => {
                    bytes += n as u64;
                    batch.extend_from_slice(&buf[..n]);
                    if batch.len() >= BATCH_BYTES || last_flush.elapsed() >= BATCH_INTERVAL {
                        let t_send = Instant::now();
                        let sent = out.send(InvokeResponseBody::Raw(std::mem::take(&mut batch)));
                        send_ns += t_send.elapsed().as_nanos();
                        flushes += 1;

                        if sent.is_err() {
                            break; // window went away
                        }

                        if flushes % 400 == 0 {
                            let line = format!(
                                "[pty] {:.1}MB | flushes {} | read {:.1}s | send {:.1}s | avg batch {:.0}KB",
                                bytes as f64 / 1048576.0,
                                flushes,
                                read_ns as f64 / 1e9,
                                send_ns as f64 / 1e9,
                                bytes as f64 / flushes as f64 / 1024.0,
                            );
                            let _ = bench_report(line);
                        }

                        batch = Vec::with_capacity(READ_BUF);
                        last_flush = Instant::now();
                    }
                }
                Err(_) => break,
            }
        }

        if !batch.is_empty() {
            let _ = out.send(InvokeResponseBody::Raw(batch));
        }
    });

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
            output: on_output,
            pid,
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such session")?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // The frontend already debounces and drops zero/duplicate sizes. This is the
    // second line of defence: ConPTY apps redraw badly when fed a bogus size.
    if cols < 2 || rows < 2 {
        return Ok(());
    }
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("no such session")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut s) = sessions.remove(&id) {
        // Claude spawns node, MCP servers and tool subprocesses. Killing only the
        // direct child leaks all of them. taskkill /T walks the tree.
        // Phase 2 replaces this with a real Job Object, which is leak-proof even
        // if the app crashes.
        if let Some(pid) = s.pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .output();
        }
        let _ = s.child.kill();
    }
    Ok(())
}

/// The WebView can reload out from under us (user reflex F5, WebView2 crash
/// recovery). The fresh frontend restores tabs by spawning new shells, so
/// whatever is still in the session map at that moment is an orphan tree of
/// pwsh/claude/node processes. Boot calls this before restoring.
#[tauri::command]
pub fn pty_kill_all(state: tauri::State<'_, PtyState>) {
    let mut sessions = state.sessions.lock().unwrap();
    for (_, mut s) in sessions.drain() {
        if let Some(pid) = s.pid {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .output();
        }
        let _ = s.child.kill();
    }
}

/// Trace sink for the frontend and the gateway. MUST live outside any folder a
/// session could be watching: writing a log line into a watched workspace makes
/// the watcher fire, which traces, which writes, which fires, forever.
pub fn log_path() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = std::path::Path::new(&base).join("tr.cryme.cockpit");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("cockpit.log")
}

#[tauri::command]
pub fn bench_report(line: String) -> Result<(), String> {
    let path = log_path();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ torture

/// Writes `megabytes` of ANSI-coloured text to a temp file, then makes the shell
/// `type` it. This exercises the real chain: ConPTY -> reader thread -> batching
/// -> IPC -> xterm render. A synthetic push straight into the channel would skip
/// ConPTY and flatter the result.
#[tauri::command]
pub fn torture_dump(
    state: tauri::State<'_, PtyState>,
    id: u32,
    megabytes: usize,
) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("cockpit_dump_{megabytes}mb.txt"));

    if !path.exists() {
        let mut line = String::new();
        for i in 0..40 {
            let colour = 31 + (i % 7);
            line.push_str(&format!("\x1b[{colour}m block{i:03} \x1b[0m"));
        }
        line.push('\n');

        let per_mb = 1_048_576 / line.len().max(1);
        let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        for _ in 0..(per_mb * megabytes) {
            f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        }
        f.flush().map_err(|e| e.to_string())?;
    }

    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such session")?;
    let cmd = format!("cmd /c type \"{}\"\r", path.display());
    s.writer
        .write_all(cmd.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;

    Ok(path.display().to_string())
}

/// CJK, emoji, ZWJ sequences, combining marks, box drawing. These are the cases
/// where ConPTY, xterm and the font disagree about cell width.
#[tauri::command]
pub fn torture_unicode(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let path = std::env::temp_dir().join("cockpit_unicode.txt");
    let sample = "\
ascii      | the quick brown fox jumps over the lazy dog | 0123456789\n\
cjk        | 日本語のテキスト 中文字符 한국어 텍스트      | wide cells\n\
turkish    | Şğüıöç ŞĞÜİÖÇ  gerçekleştirilebilirlik       | latin-ext\n\
emoji      | 🎉 🚀 ✅ ❌ ⚠️  🔥 💾 🧠                        | width guesswork\n\
zwj family | 👨‍👩‍👧‍👦 👩‍💻 🏳️‍🌈                                  | grapheme clusters\n\
combining  | e\u{0301} a\u{0300} o\u{0308} n\u{0303}      | combining marks\n\
box        | ┌────────┬────────┐                          | drawing\n\
box        | │ left   │ right  │                          | drawing\n\
box        | └────────┴────────┘                          | drawing\n\
powerline  | \u{e0b0} \u{e0b1} \u{e0b2} \u{e0b3}          | needs a nerd font\n";

    std::fs::write(&path, sample).map_err(|e| e.to_string())?;

    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such session")?;
    let cmd = format!("cmd /c type \"{}\"\r", path.display());
    s.writer
        .write_all(cmd.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

/// Enter the alternate screen, draw, leave. Tests that the main buffer and
/// scrollback survive, which is what breaks when tab switching recreates an
/// xterm instance.
///
/// An earlier version of this pushed the escape sequences straight into the
/// output channel. Do not do that. ConPTY keeps its own model of the screen and
/// emits diffs against it, so writing behind its back desyncs the two and every
/// later redraw is computed from a wrong picture. It renders as glitching.
/// The sequences have to originate from a real process inside the PTY.
#[tauri::command]
pub fn torture_alt_screen(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let script = std::env::temp_dir().join("cockpit_altscreen.ps1");
    let body = r#"$e = [char]27
Write-Host "$e[?1049h$e[2J$e[H" -NoNewline
Write-Host "$e[1;33m  ALTERNATE SCREEN  $e[0m"
Write-Host ""
Write-Host "  Scrollback behind this should be untouched."
Write-Host "  Returning to the main buffer in 3 seconds..."
Start-Sleep -Seconds 3
Write-Host "$e[?1049l" -NoNewline
Write-Host "$e[32m[alt screen exited]$e[0m"
"#;
    std::fs::write(&script, body).map_err(|e| e.to_string())?;

    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such session")?;
    let cmd = format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"\r",
        script.display()
    );
    s.writer
        .write_all(cmd.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}
