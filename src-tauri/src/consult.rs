// Claude <-> Copilot bridge: `crydeck consult` asks GitHub Copilot CLI a
// question headlessly and hands back only the final answer.
//
// Why headless and not the Copilot tab's terminal: reading an agent's TUI back
// through the pty gives redraws, wraps and spinner frames, and a typed message
// can land on a permission prompt. `copilot -p --output-format json` gives a
// JSONL event stream with an explicit final answer and exit code instead.
//
// Off by default. Copilot may run against a company GitHub Enterprise account,
// and consulting it copies that answer into whichever session asked, so the
// user turns it on deliberately in the About card.
//
// Read-only by default: every tool is pre-approved (non-interactive mode needs
// that) but writes and shell are denied, and denials beat approvals. `write`
// lifts the denials for an explicit delegation.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A consult that has not finished after this long is killed.
const CONSULT_TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct CopilotConfig {
    /// Bridge on/off (`crydeck consult`).
    #[serde(default)]
    pub bridge: bool,
    /// GitHub host for Copilot, e.g. "company.ghe.com". Empty = github.com.
    /// Passed as COPILOT_GH_HOST so it never retargets the user's `gh` CLI.
    #[serde(default)]
    pub host: String,
    /// Default model for Copilot tabs and consults. Empty = "auto".
    #[serde(default)]
    pub model: String,
}

fn cfg_path(dir: &Path) -> PathBuf {
    dir.join("copilot.json")
}

pub fn load(dir: &Path) -> CopilotConfig {
    std::fs::read_to_string(cfg_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn gw_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.try_state::<crate::hooks::Gateway>()
        .map(|g| g.dir.clone())
        .ok_or_else(|| "gateway not ready".to_string())
}

#[tauri::command]
pub fn copilot_config_get(app: tauri::AppHandle) -> Result<CopilotConfig, String> {
    Ok(load(&gw_dir(&app)?))
}

#[tauri::command]
pub fn copilot_config_set(app: tauri::AppHandle, cfg: CopilotConfig) -> Result<(), String> {
    let mut cfg = cfg;
    cfg.host = cfg.host.trim().trim_start_matches("https://").trim_end_matches('/').to_string();
    cfg.model = cfg.model.trim().to_string();
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(cfg_path(&gw_dir(&app)?), json).map_err(|e| e.to_string())
}

/// Environment for any Copilot process CryDeck starts (tabs and consults).
pub fn copilot_env(cfg: &CopilotConfig) -> Vec<(String, String)> {
    let mut v = Vec::new();
    if !cfg.host.is_empty() && cfg.host != "github.com" {
        v.push(("COPILOT_GH_HOST".into(), cfg.host.clone()));
    }
    v
}

pub struct ConsultReq {
    pub prompt: String,
    pub cwd: String,
    pub model: String,
    pub session: String,
    pub write: bool,
}

pub struct ConsultOut {
    pub ok: bool,
    pub answer: String,
    pub session: String,
    pub detail: String,
}

pub fn run(dir: &Path, req: ConsultReq) -> ConsultOut {
    let cfg = load(dir);
    let fail = |detail: String| ConsultOut { ok: false, answer: String::new(), session: String::new(), detail };
    if !cfg.bridge {
        return fail("The Copilot bridge is off. Turn it on in CryDeck: About (ⓘ) → Copilot → \"Let sessions consult Copilot\".".into());
    }
    if req.prompt.trim().is_empty() {
        return fail("empty prompt".into());
    }
    let model = [req.model.as_str(), cfg.model.as_str()]
        .into_iter()
        .find(|m| !m.trim().is_empty())
        .unwrap_or("auto")
        .to_string();

    // winget installs copilot.exe; an npm install only ships copilot.cmd, which
    // Command::new does not resolve by bare name.
    let exe = if crate::fs::quiet("where.exe").arg("copilot.exe").output().map(|o| o.status.success()).unwrap_or(false) {
        "copilot"
    } else {
        "copilot.cmd"
    };
    let mut cmd = crate::fs::quiet(exe);
    cmd.arg("-p").arg(&req.prompt)
        .args(["--output-format", "json", "--no-ask-user", "--no-auto-update", "--allow-all-tools"])
        .args(["--model", &model]);
    if !req.write {
        cmd.args(["--deny-tool=write", "--deny-tool=shell"]);
    }
    if is_id(&req.session) {
        cmd.arg(format!("--session-id={}", req.session));
    }
    if !req.cwd.is_empty() && Path::new(&req.cwd).is_dir() {
        cmd.arg("-C").arg(&req.cwd).current_dir(&req.cwd);
    }
    for (k, v) in copilot_env(&cfg) {
        cmd.env(k, v);
    }
    // Same scrub as the tabs: a Claude parent must not leak its markers.
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") {
            cmd.env_remove(&k);
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("could not start copilot ({e}). Is GitHub Copilot CLI installed?")),
    };
    let mut stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.take(64 * 1024).read_to_string(&mut s);
        }
        s
    });

    // Watchdog: kill a consult that runs past the timeout.
    let pid = child.id();
    let started = Instant::now();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done_w = done.clone();
    std::thread::spawn(move || {
        while !done_w.load(std::sync::atomic::Ordering::Relaxed) {
            if started.elapsed() > CONSULT_TIMEOUT {
                let _ = crate::fs::quiet("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).output();
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });

    let mut finals: Vec<String> = Vec::new();
    let mut last_msg = String::new();
    let mut session = String::new();
    let mut exit_code: Option<i64> = None;
    let mut errors: Vec<String> = Vec::new();
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v["type"].as_str().unwrap_or("") {
                "assistant.message" => {
                    let c = v["data"]["content"].as_str().unwrap_or("").to_string();
                    if c.trim().is_empty() {
                        continue;
                    }
                    if v["data"]["phase"].as_str() == Some("final_answer") {
                        finals.push(c.clone());
                    }
                    last_msg = c;
                }
                "session.error" => {
                    errors.push(v["data"]["message"].as_str().unwrap_or("error").to_string());
                }
                "result" => {
                    session = v["sessionId"].as_str().unwrap_or("").to_string();
                    exit_code = v["exitCode"].as_i64();
                }
                _ => {}
            }
        }
    }
    let status = child.wait();
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let stderr_text = err_thread.join().unwrap_or_default();

    let answer = if finals.is_empty() { last_msg } else { finals.join("\n\n") };
    let ok = exit_code == Some(0) && !answer.trim().is_empty();
    let mut detail = errors.join("\n");
    if !ok && detail.is_empty() {
        detail = if started.elapsed() > CONSULT_TIMEOUT {
            format!("timed out after {} min", CONSULT_TIMEOUT.as_secs() / 60)
        } else {
            let tail: String = stderr_text.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            format!("copilot exited ({:?}) {}", status.ok().and_then(|s| s.code()), tail)
        };
    }

    // Durable copy, so an answer is never lost to a closed terminal.
    let log_dir = dir.join("consults");
    if std::fs::create_dir_all(&log_dir).is_ok() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let body = format!(
            "# consult {stamp}\n\nmodel: {model}\nsession: {session}\ncwd: {}\nwrite: {}\nok: {ok}\n\n## Prompt\n\n{}\n\n## Answer\n\n{}\n\n{}\n",
            req.cwd, req.write, req.prompt, answer, detail
        );
        let _ = std::fs::write(log_dir.join(format!("{stamp}.md")), body);
    }

    ConsultOut { ok, answer, session, detail }
}

fn is_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// %XX + '+' decoding for query values the CLI percent-encodes.
pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 3 <= b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => { out.push(v); i += 3; }
                    Err(_) => { out.push(b'%'); i += 1; }
                }
            }
            b'+' => { out.push(b' '); i += 1; }
            c => { out.push(c); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

