// Real-time tree updates. One recursive watcher per session root, filtered
// hard before anything crosses to the WebView, coalesced to at most ~4
// refreshes a second. The frontend just re-lists what it has expanded.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Directories whose churn is noise at tree granularity. A change inside them
/// never repaints the tree (the tree does show the folders themselves).
const DENY: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", "coverage",
    "__pycache__", ".venv", ".cache", ".turbo", ".parcel-cache",
];

fn denied(p: &Path) -> bool {
    p.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        DENY.iter().any(|d| s.eq_ignore_ascii_case(d))
    })
}

#[derive(Default)]
pub struct WatchState {
    watchers: Mutex<HashMap<u32, RecommendedWatcher>>,
}

#[derive(serde::Serialize, Clone)]
struct FsEvent {
    tab: u32,
}

#[tauri::command]
pub fn fs_watch(
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
    tab: u32,
    root: String,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<()>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| !denied(p)) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Debounce thread: first event arms a 250ms window, everything inside it
    // collapses into one emit. Thread dies when the watcher is dropped and the
    // channel disconnects.
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            let deadline = std::time::Instant::now() + Duration::from_millis(250);
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                if rx.recv_timeout(left).is_err() {
                    break;
                }
            }
            let _ = app.emit("cockpit-fs", FsEvent { tab });
        }
    });

    state.watchers.lock().unwrap().insert(tab, watcher);
    Ok(())
}

#[tauri::command]
pub fn fs_unwatch(state: tauri::State<'_, WatchState>, tab: u32) {
    state.watchers.lock().unwrap().remove(&tab);
}
