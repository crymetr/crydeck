// Hook gateway. Claude Code reports what it does through hooks; this module
// receives those reports and turns them into UI events.
//
// Shape: a loopback-only HTTP listener on a random port with a per-run bearer
// token. Two generated .cmd shims (statusLine, PostToolUse) POST their stdin to
// it via curl.exe, carrying the tab identity from the inherited COCKPIT_TAB_ID
// env var. A generated settings.json wires the shims in, and a generated
// init.ps1 wraps `claude` so the settings ride along via --settings.
// The user's own settings.json is never touched.

use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

pub struct Gateway {
    pub port: u16,
    pub token: String,
    pub dir: PathBuf,
}

#[derive(serde::Serialize, Clone)]
struct HookEvent {
    tab: u32,
    raw: String,
}

/// Loopback + random port + random token. The token is not high security, it
/// only stops another local process from casually spraying fake events.
pub fn start(app: AppHandle) -> Result<Gateway, String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a.port(),
        _ => return Err("no tcp addr".into()),
    };
    let token = random_token();

    let dir = app
        .path_resolver_dir()
        .ok_or("no local data dir")?
        .join("cockpit-hooks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_artifacts(&dir, port, &token)?;

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
            let tab: u32 = q.get("tab").and_then(|t| t.parse().ok()).unwrap_or(u32::MAX);
            if tab == u32::MAX {
                // The shim's %COCKPIT_TAB_ID% did not expand: the hook ran in
                // an environment that never inherited the tab identity.
                gwlog(&format!("{path} with unresolved tab id: {:?}", q.get("tab")));
            }

            let mut body = String::new();
            // Hook payloads are small JSON; cap defensively at 1MB.
            let _ = req.as_reader().take(1_048_576).read_to_string(&mut body);

            match path.as_str() {
                "/status" => {
                    gwlog(&format!("status tab={tab} {}B", body.len()));
                    let line = render_status_line(&body);
                    let _ = app.emit("cockpit-status", HookEvent { tab, raw: body });
                    let _ = req.respond(resp(200, &line));
                }
                "/tool" => {
                    gwlog(&format!("tool tab={tab} {}B", body.len()));
                    let _ = app.emit("cockpit-tool", HookEvent { tab, raw: body });
                    let _ = req.respond(resp(200, ""));
                }
                _ => {
                    let _ = req.respond(resp(404, ""));
                }
            }
        }
    });

    Ok(Gateway { port, token, dir })
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

fn write_artifacts(dir: &PathBuf, port: u16, token: &str) -> Result<(), String> {
    let curl = r"%SystemRoot%\System32\curl.exe";
    let status_cmd = dir.join("hook-status.cmd");
    let tool_cmd = dir.join("hook-tool.cmd");
    let settings = dir.join("settings.json");
    let init = dir.join("init.ps1");

    // .cmd shims guarantee cmd.exe semantics for %VAR% expansion no matter how
    // the parent process invokes hooks. -m 2 so a dead gateway never wedges
    // Claude's render loop.
    // These shims are wired into the USER settings (see install_user_settings)
    // because Claude Code does not trust statusLine/hooks from --settings
    // files. The guard makes them free in Claude sessions outside Cockpit.
    std::fs::write(
        &status_cmd,
        format!(
            "@if not defined COCKPIT_TAB_ID exit /b 0\r\n@{curl} -s -m 2 --data-binary @- \"http://127.0.0.1:{port}/status?tab=%COCKPIT_TAB_ID%&token={token}\"\r\n"
        ),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        &tool_cmd,
        format!(
            "@if not defined COCKPIT_TAB_ID exit /b 0\r\n@{curl} -s -m 2 --data-binary @- \"http://127.0.0.1:{port}/tool?tab=%COCKPIT_TAB_ID%&token={token}\" >nul\r\n"
        ),
    )
    .map_err(|e| e.to_string())?;
    install_user_settings(&status_cmd, &tool_cmd)?;

    let settings_json = serde_json::json!({
        "statusLine": { "type": "command", "command": status_cmd.to_string_lossy() },
        "hooks": {
            "PostToolUse": [{
                "matcher": "Edit|Write|MultiEdit|NotebookEdit",
                "hooks": [{ "type": "command", "command": tool_cmd.to_string_lossy() }]
            }]
        }
    });
    std::fs::write(
        &settings,
        serde_json::to_string_pretty(&settings_json).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    // Hooks now ride in via user settings (install_user_settings), so the
    // shell init only carries PSReadLine predictions and the banner. The
    // try/catch ladder: HistoryAndPlugin needs pwsh 7, History works on any
    // PSReadLine 2.1+, and Windows PowerShell 5 just skips both.
    let init_ps1 = r#"# Generated by Cockpit on every launch. Do not edit; edits are overwritten.
try { Set-PSReadLineOption -PredictionSource HistoryAndPlugin -ErrorAction Stop }
catch { try { Set-PSReadLineOption -PredictionSource History -ErrorAction Stop } catch {} }
try { Set-PSReadLineOption -PredictionViewStyle InlineView } catch {}
Write-Host "cockpit session | tab $env:COCKPIT_TAB_ID | hooks active" -ForegroundColor DarkCyan
"#;
    std::fs::write(&init, init_ps1).map_err(|e| e.to_string())?;
    let _ = &settings; // still generated for --settings power users / debugging
    Ok(())
}

/// Gateway diagnostics into the same trace file everything else uses. This is
/// how "the status bar is empty" gets diagnosed: no line here means the hook
/// never fired; a line with a wrong tab means env inheritance broke.
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

/// Merge the statusLine + PostToolUse entries into ~/.claude/settings.json.
/// Rules: back up the original once, never replace a statusLine we did not
/// write, never duplicate the hook entry. Shim paths are stable across runs
/// (only their contents change per run), so this converges after one install.
fn install_user_settings(status_cmd: &Path, tool_cmd: &Path) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    let file = Path::new(&home).join(".claude").join("settings.json");
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;

    let mut v: serde_json::Value = match std::fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("user settings unparseable, not touching it: {e}"))?,
        Err(_) => serde_json::json!({}),
    };
    let backup = file.with_extension("json.pre-cockpit");
    if file.exists() && !backup.exists() {
        std::fs::copy(&file, &backup).map_err(|e| e.to_string())?;
    }

    let status_str = status_cmd.to_string_lossy().to_string();
    let tool_str = tool_cmd.to_string_lossy().to_string();
    let mut changed = false;

    match v.get("statusLine") {
        None => {
            v["statusLine"] = serde_json::json!({ "type": "command", "command": status_str });
            changed = true;
        }
        Some(existing) => {
            let cur = existing.pointer("/command").and_then(|c| c.as_str()).unwrap_or("");
            if cur != status_str && !cur.contains("cockpit-hooks") {
                gwlog(&format!("foreign statusLine present, leaving it alone: {cur}"));
            }
        }
    }

    let post = v
        .pointer_mut("/hooks")
        .and_then(|h| h.as_object_mut())
        .map(|_| ())
        .is_some();
    if !post {
        v["hooks"] = serde_json::json!({});
    }
    let hooks = v["hooks"].as_object_mut().unwrap();
    let arr = hooks
        .entry("PostToolUse")
        .or_insert_with(|| serde_json::json!([]));
    let already = arr
        .as_array()
        .map(|a| {
            a.iter().any(|e| {
                e.pointer("/hooks")
                    .and_then(|h| h.as_array())
                    .map(|hs| hs.iter().any(|h| h.pointer("/command").and_then(|c| c.as_str()) == Some(tool_str.as_str())))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if !already {
        if let Some(a) = arr.as_array_mut() {
            a.push(serde_json::json!({
                "matcher": "Edit|Write|MultiEdit|NotebookEdit",
                "hooks": [{ "type": "command", "command": tool_str }]
            }));
            changed = true;
        }
    }

    if changed {
        std::fs::write(&file, serde_json::to_string_pretty(&v).unwrap())
            .map_err(|e| e.to_string())?;
        gwlog("installed cockpit statusLine + PostToolUse into user settings");
    }
    Ok(())
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
    // No rand crate: hash a few entropy sources. Casual-collision-proof is all
    // this needs to be (see start()).
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

/// The frontend needs the init script path to spawn shells, and shows the port
/// in a diagnostics tooltip.
#[derive(serde::Serialize)]
pub struct GatewayInfo {
    port: u16,
    init_ps1: String,
    settings_json: String,
}

#[tauri::command]
pub fn gateway_info(state: tauri::State<'_, Gateway>) -> GatewayInfo {
    GatewayInfo {
        port: state.port,
        init_ps1: state.dir.join("init.ps1").to_string_lossy().to_string(),
        settings_json: state.dir.join("settings.json").to_string_lossy().to_string(),
    }
}
