// Filesystem service. Read-only by design: Cockpit never writes into a
// workspace, Claude does. The only writes here are OS-open handoffs.

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

/// Every process a GUI app spawns pops a console window unless told not to.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn quiet(cmd: &str) -> std::process::Command {
    let mut c = std::process::Command::new(cmd);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Preview refuses anything bigger than this. The pane is a viewer, not a pager.
const MAX_TEXT_BYTES: u64 = 1_048_576; // 1MB
const MAX_IMAGE_BYTES: u64 = 8 * 1_048_576; // 8MB

#[derive(Serialize)]
pub struct Entry {
    name: String,
    is_dir: bool,
}

/// One directory level, dirs first, case-insensitive alpha. Lazy: the frontend
/// calls again on expand. Never recurses, so pointing a tab at C:\ is safe.
#[tauri::command]
pub fn fs_list(dir: String) -> Result<Vec<Entry>, String> {
    let mut dirs: Vec<Entry> = Vec::new();
    let mut files: Vec<Entry> = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{dir}: {e}"))?;
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            dirs.push(Entry { name, is_dir });
        } else {
            files.push(Entry { name, is_dir });
        }
    }
    let key = |e: &Entry| e.name.to_lowercase();
    dirs.sort_by_key(key);
    files.sort_by_key(key);
    dirs.extend(files);
    Ok(dirs)
}

#[derive(Serialize)]
#[serde(tag = "kind")]
pub enum FileContent {
    #[serde(rename = "text")]
    Text { text: String, truncated: bool },
    #[serde(rename = "image")]
    Image { base64: String, mime: String },
    #[serde(rename = "binary")]
    Binary { size: u64 },
    #[serde(rename = "too_big")]
    TooBig { size: u64 },
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

#[tauri::command]
pub fn fs_read(path: String) -> Result<FileContent, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("{path}: {e}"))?;
    let size = meta.len();

    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if let Some(mime) = image_mime(&ext) {
        if size > MAX_IMAGE_BYTES {
            return Ok(FileContent::TooBig { size });
        }
        let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
        return Ok(FileContent::Image {
            base64: base64_encode(&bytes),
            mime: mime.to_string(),
        });
    }

    if size > MAX_TEXT_BYTES {
        // Text files above the cap still get their head shown rather than a
        // refusal: logs are the common case here.
        let bytes = read_head(p, MAX_TEXT_BYTES as usize)?;
        return match String::from_utf8(bytes) {
            Ok(text) => Ok(FileContent::Text {
                text,
                truncated: true,
            }),
            Err(_) => Ok(FileContent::TooBig { size }),
        };
    }

    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    // Binary sniff: NUL byte in the first 8KB.
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Ok(FileContent::Binary { size });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent::Text {
            text,
            truncated: false,
        }),
        Err(e) => {
            // Not UTF-8 but not obviously binary: show it lossily.
            let text = String::from_utf8_lossy(e.as_bytes()).to_string();
            Ok(FileContent::Text {
                text,
                truncated: false,
            })
        }
    }
}

fn read_head(p: &Path, n: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; n];
    let mut got = 0;
    while got < n {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(e) => return Err(e.to_string()),
        }
    }
    buf.truncate(got);
    // Do not split a UTF-8 codepoint at the cut.
    while !buf.is_empty() && (buf[buf.len() - 1] & 0b1100_0000) == 0b1000_0000 {
        buf.pop();
    }
    Ok(buf)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Uncommitted paths (modified + untracked) for a session root, absolute.
/// Empty on any failure: not a repo, no git, whatever — decoration only.
#[tauri::command]
pub fn git_status(root: String) -> Vec<String> {
    let out = match quiet("git")
        .args(["-C", &root, "status", "--porcelain", "-z"])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out);
    let mut result = Vec::new();
    let mut chunks = text.split('\0');
    while let Some(c) = chunks.next() {
        if c.len() < 4 {
            continue;
        }
        let (xy, path) = c.split_at(3);
        // Rename/copy entries carry the old path in the next chunk; skip it.
        if xy.starts_with('R') || xy.starts_with('C') {
            let _ = chunks.next();
        }
        let p = path.trim_end_matches('/').replace('/', "\\");
        result.push(format!("{}\\{}", root.trim_end_matches(['\\', '/']), p));
    }
    result
}

/// Unified diff for one file vs HEAD; untracked files diff against nothing so
/// the whole file shows as added. Empty string = no diff (clean, or no git).
#[tauri::command]
pub fn git_diff(root: String, path: String) -> String {
    let run = |args: &[&str], allow_one: bool| {
        quiet("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success() || (allow_one && o.status.code() == Some(1)))
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    };
    let d = run(&["-C", &root, "diff", "HEAD", "--", &path], false);
    if !d.is_empty() {
        return d;
    }
    // Untracked file: --no-index exits 1 when there ARE differences.
    run(&["-C", &root, "diff", "--no-index", "--", "NUL", &path], true)
}

/// Tracked + untracked (respecting .gitignore) file list for the Cmd+P finder.
/// Forward slashes, capped so a giant repo can't flood the palette. Empty when
/// the folder isn't a git repo — the finder just shows nothing then.
#[tauri::command]
pub fn git_ls_files(root: String) -> Vec<String> {
    let out = match quiet("git")
        .args([
            "-C",
            &root,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out)
        .lines()
        .take(20_000)
        .map(|s| s.to_string())
        .collect()
}

#[derive(Serialize)]
pub struct GrepHit {
    file: String,
    line: u32,
    text: String,
}

/// Find-in-files (Cmd+Shift+F), backed by `git grep`: tracked content only,
/// case-insensitive, binary files skipped, capped. Empty query or non-repo
/// returns nothing.
#[tauri::command]
pub fn git_grep(root: String, query: String) -> Vec<GrepHit> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let out = match quiet("git")
        .args([
            "-C", &root, "grep", "-n", "-I", "-i", "--no-color", "-e", &query,
        ])
        .output()
    {
        Ok(o) if o.status.success() || o.status.code() == Some(1) => o.stdout,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out)
        .lines()
        .take(500)
        .filter_map(|l| {
            // path:line:text
            let (file, rest) = l.split_once(':')?;
            let (line, text) = rest.split_once(':')?;
            Some(GrepHit {
                file: file.to_string(),
                line: line.parse().unwrap_or(0),
                text: text.chars().take(200).collect(),
            })
        })
        .collect()
}

/// Open the folder in VS Code. `code` is a .cmd shim, so it needs a shell to
/// resolve; cmd /c handles that. No-op-ish if VS Code isn't installed (the
/// child just fails silently, like the other os handoffs).
#[tauri::command]
pub fn open_in_editor(root: String) -> Result<(), String> {
    quiet("cmd")
        .args(["/c", "code", &root])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn on_path(cmd: &str) -> bool {
    quiet("where.exe")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// First-run bootstrap: sessions are useless without Claude Code, and Claude
/// Code on Windows needs git (hooks run through Git Bash). PowerShell 7 (pwsh)
/// matters too: when it is absent we fall back to Windows PowerShell 5.1, which
/// on some machines renders a dead black terminal under ConPTY — so we treat a
/// missing pwsh as a prerequisite to install, not just a silent fallback.
#[derive(Serialize)]
pub struct EnvCheck {
    pub git: bool,
    pub claude: bool,
    pub pwsh: bool,
}

#[tauri::command]
pub fn env_check() -> EnvCheck {
    EnvCheck { git: on_path("git"), claude: on_path("claude"), pwsh: on_path("pwsh") }
}

/// Where a first-run setup session lands: a real projects folder, created if
/// needed, so Claude works somewhere sane from day one instead of the profile
/// root.
#[tauri::command]
pub fn projects_dir() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    let p = PathBuf::from(&home).join("Projects");
    let _ = std::fs::create_dir_all(&p);
    p.to_string_lossy().into_owned()
}

/// Double-click a file: hand it to whatever the OS associates with it.
/// `cmd /c start` resolves associations; the empty "" is start's window title
/// slot, without it a quoted path is eaten as the title.
#[tauri::command]
pub fn os_open(path: String) -> Result<(), String> {
    quiet("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Double-click a folder: a fresh Explorer window there.
#[tauri::command]
pub fn os_explore(path: String) -> Result<(), String> {
    quiet("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The personal prompt library lives outside the app bundle so it survives
/// updates and any Claude session can append to it by editing the file.
pub fn crydeck_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    let p = PathBuf::from(&home).join(".crydeck");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn prompts_file() -> PathBuf {
    crydeck_dir().join("prompts.json")
}

#[tauri::command]
pub fn prompts_load() -> String {
    std::fs::read_to_string(prompts_file()).unwrap_or_else(|_| "{\"prompts\":[]}".into())
}

#[tauri::command]
pub fn prompts_save(json: String) -> Result<(), String> {
    std::fs::write(prompts_file(), json).map_err(|e| e.to_string())
}

/// Explorer-copied files on the clipboard (CF_HDROP), so Ctrl+V in a terminal
/// can paste their paths instead of nothing. Empty when the clipboard holds
/// text or an image.
#[tauri::command]
pub fn clip_paths() -> Vec<String> {
    clipboard_win::get_clipboard::<Vec<String>, _>(clipboard_win::formats::FileList)
        .unwrap_or_default()
}

/// A pasted clipboard image lands here as a real file so the path can be typed
/// into the session and Claude can read it.
#[tauri::command]
pub fn save_paste(name: String, b64: String) -> Result<String, String> {
    let dir = crydeck_dir().join("pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{stamp}-{safe}"));
    std::fs::write(&path, base64_decode(&b64)?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let val = |c: u8| -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("bad base64".into()),
        }
    };
    let bytes: Vec<u8> = s.bytes().filter(|&b| b != b'=' && b != b'\n' && b != b'\r').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct CodeBlock {
    lang: String,
    code: String,
}

/// Fenced code blocks from the newest Claude Code transcript for this cwd,
/// newest first — feeds the one-click-copy Code pane. Claude Code writes each
/// session to ~\.claude\projects\<encoded-cwd>\<session>.jsonl as it goes, so
/// this is the same text the terminal shows, without scraping the terminal.
#[tauri::command]
pub fn code_blocks(cwd: String) -> Vec<CodeBlock> {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    // Claude Code's project-dir encoding: every non-alphanumeric char -> '-'.
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = PathBuf::from(home).join(".claude").join("projects").join(enc);

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                if let Some(t) = e.metadata().ok().and_then(|m| m.modified().ok()) {
                    if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                        best = Some((t, p));
                    }
                }
            }
        }
    }
    let Some((_, path)) = best else { return Vec::new() };

    // Transcripts grow to tens of MB; only the tail matters for "recent blocks".
    let text = match read_tail(&path, 2 * 1_048_576) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) else {
            continue;
        };
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) != Some("text") {
                continue;
            }
            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                extract_fences(text, &mut out);
            }
        }
    }
    let n = out.len();
    if n > 30 {
        out.drain(0..n - 30);
    }
    out.reverse();
    out
}

fn extract_fences(text: &str, out: &mut Vec<CodeBlock>) {
    let mut lines = text.lines();
    while let Some(l) = lines.next() {
        let t = l.trim_start();
        if let Some(rest) = t.strip_prefix("```") {
            let lang = rest.trim().to_string();
            let mut code = String::new();
            for l2 in lines.by_ref() {
                if l2.trim_start().starts_with("```") {
                    break;
                }
                code.push_str(l2);
                code.push('\n');
            }
            if !code.trim().is_empty() {
                out.push(CodeBlock { lang, code });
            }
        }
    }
}

/// Last `n` bytes of a file as UTF-8, starting from the first complete line.
fn read_tail(p: &Path, n: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(n);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(i) = s.find('\n') {
            s.drain(..=i);
        }
    }
    Ok(s)
}

/// `cockpit <folder>` opens a session there on boot. Also what the smoke test
/// drives, since a headless run cannot click the folder picker.
#[tauri::command]
pub fn boot_folder() -> Option<String> {
    let arg = std::env::args().nth(1)?;
    let p = PathBuf::from(&arg);
    p.is_dir().then(|| p.to_string_lossy().to_string())
}

/// Native folder picker for the new-tab flow. rfd blocks, so Tauri runs this
/// command off the main thread already (async command on a worker).
#[tauri::command]
pub async fn pick_folder(start_dir: Option<String>) -> Option<String> {
    let mut dlg = rfd::FileDialog::new().set_title("New session folder");
    if let Some(d) = start_dir {
        let p = PathBuf::from(d);
        if p.is_dir() {
            dlg = dlg.set_directory(p);
        }
    }
    dlg.pick_folder().map(|p| p.to_string_lossy().to_string())
}
