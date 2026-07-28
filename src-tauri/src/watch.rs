// Real-time tree updates, v2. The v1 recursive watcher made a tab on C:\dev
// watch the whole dev drive, exactly what PLAN.md forbids. Now each session
// watches precisely what its tree is showing: the root plus every expanded
// folder, each NON-recursively. The frontend re-syncs the set whenever
// expansion changes. A project folder Claude creates under the root fires the
// root watch and appears immediately; churn deep inside collapsed folders is
// invisible and free.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

struct SessionWatch {
    watcher: RecommendedWatcher,
    dirs: HashSet<String>,
}

#[derive(Default)]
pub struct WatchState {
    sessions: Mutex<HashMap<u32, SessionWatch>>,
}

#[derive(serde::Serialize, Clone)]
struct FsEvent {
    tab: u32,
}

/// Replace the watched-directory set for a session. Idempotent; the frontend
/// calls it with the full current set on every expansion change.
#[tauri::command]
pub fn fs_watch_dirs(
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
    tab: u32,
    dirs: Vec<String>,
) -> Result<(), String> {
    let want: HashSet<String> = dirs
        .into_iter()
        .map(|d| d.trim_end_matches(['\\', '/']).to_lowercase())
        .collect();

    let mut sessions = state.sessions.lock().unwrap();

    let entry = match sessions.get_mut(&tab) {
        Some(e) => e,
        None => {
            let (tx, rx) = mpsc::channel::<()>();
            let watcher = notify::recommended_watcher(
                move |res: notify::Result<notify::Event>| {
                    if res.is_ok() {
                        let _ = tx.send(());
                    }
                },
            )
            .map_err(|e| e.to_string())?;

            // Debounce thread per session: first event arms a 250ms window,
            // everything inside collapses to one emit. Exits when the watcher
            // drops and the channel disconnects.
            let app = app.clone();
            std::thread::spawn(move || {
                while rx.recv().is_ok() {
                    let deadline = std::time::Instant::now() + Duration::from_millis(250);
                    while let Some(left) =
                        deadline.checked_duration_since(std::time::Instant::now())
                    {
                        if rx.recv_timeout(left).is_err() {
                            break;
                        }
                    }
                    let _ = app.emit("cockpit-fs", FsEvent { tab });
                }
            });

            sessions.insert(
                tab,
                SessionWatch {
                    watcher,
                    dirs: HashSet::new(),
                },
            );
            sessions.get_mut(&tab).unwrap()
        }
    };

    for gone in entry.dirs.difference(&want).cloned().collect::<Vec<_>>() {
        let _ = entry.watcher.unwatch(Path::new(&gone));
        entry.dirs.remove(&gone);
    }
    for new in want.difference(&entry.dirs).cloned().collect::<Vec<_>>() {
        // A dir can vanish between expand and sync (Claude deleted it); a
        // failed watch is not an error, the next tree refresh drops it.
        if entry.watcher.watch(Path::new(&new), RecursiveMode::NonRecursive).is_ok() {
            entry.dirs.insert(new);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn fs_unwatch(state: tauri::State<'_, WatchState>, tab: u32) {
    state.sessions.lock().unwrap().remove(&tab);
}
