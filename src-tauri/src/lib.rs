mod fs;
mod hooks;
mod pty;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(pty::PtyState::default())
    .manage(watch::WatchState::default())
    .invoke_handler(tauri::generate_handler![
      pty::pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      pty::pty_kill_all,
      pty::bench_report,
      fs::fs_list,
      fs::fs_read,
      fs::os_open,
      fs::os_explore,
      fs::pick_folder,
      fs::boot_folder,
      fs::git_status,
      hooks::gateway_info,
      watch::fs_watch_dirs,
      watch::fs_unwatch,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // The gateway must be up before any shell spawns, since every session's
      // hook shims are generated with this run's port and token.
      let gw = hooks::start(app.handle().clone())
        .map_err(|e| std::io::Error::other(format!("hook gateway: {e}")))?;
      {
        use tauri::Manager;
        app.manage(gw);
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
