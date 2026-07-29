// Filesystem service. Read-only by design: Cockpit never writes into a
// workspace, Claude does. The only writes here are OS-open handoffs.

use serde::Serialize;
use std::path::{Path, PathBuf};

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
    let out = match std::process::Command::new("git")
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

/// Double-click a file: hand it to whatever the OS associates with it.
/// `cmd /c start` resolves associations; the empty "" is start's window title
/// slot, without it a quoted path is eaten as the title.
#[tauri::command]
pub fn os_open(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Double-click a folder: a fresh Explorer window there.
#[tauri::command]
pub fn os_explore(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
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
