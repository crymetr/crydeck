// Hook gateway. Claude Code reports what it does through hooks; this module
// receives those reports and turns them into UI events.
//
// Windows lesson (cost us three debugging rounds): Claude Code executes hook
// commands through whatever shell it resolves — usually git-bash, sometimes
// cmd — so any shell-specific syntax (.cmd shims, %VAR%, $VAR) dies silently
// in one of them. The installed hook command is therefore ONE direct curl.exe
// invocation with zero shell constructs, valid in cmd, bash and PowerShell.
//
// Tab identity: the hook payload itself carries session_id and cwd; the
// frontend maps those to tabs. No env vars involved.
//
// Stability: the command string is written into the user's settings.json once,
// so the gateway uses a fixed port range and a token persisted in app data.
// If the port drifts (collision), the installer rewrites the entries that
// boot. The original settings.json is backed up once as .pre-cockpit.

use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const PORT_RANGE: std::ops::Range<u16> = 48620..48640;

pub struct Gateway {
    pub port: u16,
    pub dir: PathBuf,
    pub token: String,
}

#[derive(serde::Serialize, Clone)]
struct HookEvent {
    raw: String,
}

pub fn start(app: AppHandle) -> Result<Gateway, String> {
    let dir = app
        .path_resolver_dir()
        .ok_or("no local data dir")?
        .join("cockpit-hooks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let server = bind_fixed_range()?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a.port(),
        _ => return Err("no tcp addr".into()),
    };
    let token = persistent_token(&dir)?;

    write_init_script(&dir)?;
    install_user_settings(port, &token)?;

    let tok = token.clone();
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let url = req.url().to_string();
            let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
            let path = path.to_string();
            let q = parse_query(query);

            if q.get("token").map(String::as_str) != Some(tok.as_str()) {
                gwlog(&format!("DENIED {path} (bad token)"));
                let _ = req.respond(resp(403, ""));
                continue;
            }

            let mut body = String::new();
            // Hook payloads are small JSON; cap defensively at 1MB.
            let _ = req.as_reader().take(1_048_576).read_to_string(&mut body);

            match path.as_str() {
                "/status" => {
                    gwlog(&format!("status {}B", body.len()));
                    let line = render_status_line(&body);
                    let _ = app.emit("cockpit-status", HookEvent { raw: body });
                    let _ = req.respond(resp(200, &line));
                }
                "/tool" => {
                    gwlog(&format!("tool {}B", body.len()));
                    let _ = app.emit("cockpit-tool", HookEvent { raw: body });
                    let _ = req.respond(resp(200, ""));
                }
                // Preview bridge: the injected picker/annotator scripts report
                // here (they cannot use Tauri IPC from a remote origin).
                "/select" => {
                    let _ = app.emit("cockpit-select", HookEvent { raw: body });
                    let _ = req.respond(resp(200, ""));
                }
                "/annotate" => {
                    let _ = app.emit("cockpit-annotate", HookEvent { raw: body });
                    let _ = req.respond(resp(200, ""));
                }
                "/pickoff" => {
                    let _ = app.emit("cockpit-pickoff", HookEvent { raw: body });
                    let _ = req.respond(resp(200, ""));
                }
                _ => {
                    let _ = req.respond(resp(404, ""));
                }
            }
        }
    });

    Ok(Gateway { port, dir, token })
}

/// Fixed range so the installed command survives restarts; scan handles a
/// squatter on the preferred port.
fn bind_fixed_range() -> Result<tiny_http::Server, String> {
    for p in PORT_RANGE {
        if let Ok(s) = tiny_http::Server::http(("127.0.0.1", p)) {
            return Ok(s);
        }
    }
    Err("no free port in cockpit gateway range".into())
}

/// Token survives restarts for the same reason. Loopback-only listener; the
/// token merely stops another local process from casually spraying events.
fn persistent_token(dir: &Path) -> Result<String, String> {
    let f = dir.join("token");
    if let Ok(t) = std::fs::read_to_string(&f) {
        let t = t.trim().to_string();
        if t.len() >= 16 {
            return Ok(t);
        }
    }
    let t = random_token();
    std::fs::write(&f, &t).map_err(|e| e.to_string())?;
    Ok(t)
}

fn hook_cmd(port: u16, token: &str, route: &str) -> String {
    // No env vars, no redirects, no operators: shell-agnostic on purpose.
    // -m 2 so a dead gateway can never wedge Claude's render loop; connection
    // refused fails in milliseconds when Cockpit is closed.
    format!("curl.exe -s -m 2 --data-binary @- \"http://127.0.0.1:{port}/{route}?token={token}\"")
}

fn is_ours(cmd: &str) -> bool {
    cmd.contains("cockpit-hooks") // legacy .cmd shims
        || (cmd.contains("127.0.0.1") && (cmd.contains("/status?token=") || cmd.contains("/tool?token=")))
}

/// Merge statusLine + PostToolUse into ~/.claude/settings.json. Rules: back up
/// the original once, replace only entries that are ours (legacy shims
/// included), never duplicate, leave a foreign statusLine untouched.
fn install_user_settings(port: u16, token: &str) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    let file = Path::new(&home).join(".claude").join("settings.json");
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;

    let mut v: serde_json::Value = match std::fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("user settings unparseable, not touching it: {e}"))?,
        Err(_) => serde_json::json!({}),
    };
    let backup = file.with_extension("json.pre-cockpit");
    if file.exists() && !backup.exists() {
        std::fs::copy(&file, &backup).map_err(|e| e.to_string())?;
    }

    let status_cmd = hook_cmd(port, token, "status");
    let tool_cmd = hook_cmd(port, token, "tool");
    let mut changed = false;

    let cur_status = v
        .pointer("/statusLine/command")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    if cur_status.is_empty() || is_ours(&cur_status) {
        if cur_status != status_cmd {
            v["statusLine"] = serde_json::json!({ "type": "command", "command": status_cmd });
            changed = true;
        }
    } else {
        gwlog(&format!("foreign statusLine present, leaving it alone: {cur_status}"));
    }

    if v.get("hooks").map(|h| !h.is_object()).unwrap_or(true) {
        v["hooks"] = serde_json::json!({});
    }
    let arr = v["hooks"]
        .as_object_mut()
        .unwrap()
        .entry("PostToolUse")
        .or_insert_with(|| serde_json::json!([]));
    if let Some(a) = arr.as_array_mut() {
        let before = a.len();
        a.retain(|e| {
            !e.pointer("/hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.pointer("/command")
                            .and_then(|c| c.as_str())
                            .map(|c| is_ours(c) && c != tool_cmd)
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });
        changed |= a.len() != before;
        let present = a.iter().any(|e| {
            e.pointer("/hooks")
                .and_then(|h| h.as_array())
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.pointer("/command").and_then(|c| c.as_str()) == Some(tool_cmd.as_str())
                    })
                })
                .unwrap_or(false)
        });
        if !present {
            a.push(serde_json::json!({
                "matcher": "Edit|Write|MultiEdit|NotebookEdit",
                "hooks": [{ "type": "command", "command": tool_cmd }]
            }));
            changed = true;
        }
    }

    if changed {
        std::fs::write(&file, serde_json::to_string_pretty(&v).unwrap())
            .map_err(|e| e.to_string())?;
        gwlog("installed/updated cockpit statusLine + PostToolUse in user settings");
    }
    Ok(())
}

/// What the Claude TUI's own status line shows. The gateway is the statusLine
/// command's stdout, so we render something short and useful rather than
/// leaving the TUI blank.
fn render_status_line(body: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return "cockpit".into(),
    };
    let model = v
        .pointer("/model/display_name")
        .and_then(|m| m.as_str())
        .unwrap_or("?");
    let mut parts = vec![model.to_string()];
    for (ptr, suffix) in [
        ("/context_window/used_percentage", "% ctx"),
        ("/rate_limits/five_hour/used_percentage", "% 5h"),
    ] {
        if let Some(p) = v.pointer(ptr).and_then(|p| p.as_f64()) {
            parts.push(format!("{:.0}{}", p, suffix));
        }
    }
    if let Some(c) = v.pointer("/cost/total_cost_usd").and_then(|c| c.as_f64()) {
        parts.push(format!("${c:.2}"));
    }
    parts.join(" | ")
}

fn write_init_script(dir: &Path) -> Result<(), String> {
    // PSReadLine try/catch ladder: HistoryAndPlugin needs pwsh 7, History works
    // on any PSReadLine 2.1+, Windows PowerShell 5 skips both.
    let init = r#"# Generated by Cockpit on every launch. Do not edit; edits are overwritten.
try { Set-PSReadLineOption -PredictionSource HistoryAndPlugin -ErrorAction Stop }
catch { try { Set-PSReadLineOption -PredictionSource History -ErrorAction Stop } catch {} }
try { Set-PSReadLineOption -PredictionViewStyle InlineView } catch {}
Write-Host "crydeck session | hooks active" -ForegroundColor DarkCyan
"#;
    std::fs::write(dir.join("init.ps1"), init).map_err(|e| e.to_string())
}

/// Gateway diagnostics into the shared trace file. This is how "the status bar
/// is empty" gets diagnosed: no line here means the hook never fired.
fn gwlog(m: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::pty::log_path())
    {
        let _ = writeln!(f, "[gw] {m}");
    }
}

fn resp(code: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_data(body.as_bytes().to_vec()).with_status_code(code)
}

fn parse_query(q: &str) -> std::collections::HashMap<String, String> {
    q.split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn random_token() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    std::process::id().hash(&mut h);
    let a = h.finish();
    a.hash(&mut h);
    (&h as *const _ as usize).hash(&mut h);
    format!("{a:016x}{:016x}", h.finish())
}

trait PathResolverExt {
    fn path_resolver_dir(&self) -> Option<PathBuf>;
}
impl PathResolverExt for AppHandle {
    fn path_resolver_dir(&self) -> Option<PathBuf> {
        use tauri::Manager;
        self.path().app_local_data_dir().ok()
    }
}

/// The frontend needs the init script path to spawn shells; the port shows in
/// the status bar while no session has reported yet.
#[derive(serde::Serialize)]
pub struct GatewayInfo {
    port: u16,
    init_ps1: String,
}

#[tauri::command]
pub fn gateway_info(state: tauri::State<'_, Gateway>) -> GatewayInfo {
    GatewayInfo {
        port: state.port,
        init_ps1: state.dir.join("init.ps1").to_string_lossy().to_string(),
    }
}
