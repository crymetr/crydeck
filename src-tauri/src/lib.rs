mod fs;
mod hooks;
mod preview;
mod pty;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // Start-with-Windows. The frontend enables this by default on first run and
    // exposes a toggle; the plugin writes/removes the HKCU Run entry on Windows.
    .plugin(tauri_plugin_autostart::Builder::new().build())
    .plugin(tauri_plugin_notification::init())
    .manage(pty::PtyState::default())
    .manage(pty::ControlState::default())
    .manage(watch::WatchState::default())
    .manage(preview::PreviewState::default())
    .invoke_handler(tauri::generate_handler![
      pty::pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      pty::pty_kill_all,
      pty::bench_report,
      pty::control_sync,
      fs::fs_list,
      fs::fs_read,
      fs::os_open,
      fs::os_explore,
      fs::pick_folder,
      fs::boot_folder,
      fs::env_check,
      fs::projects_dir,
      fs::git_status,
      fs::git_diff,
      fs::git_ls_files,
      fs::git_grep,
      fs::open_in_editor,
      fs::prompts_load,
      fs::prompts_save,
      fs::clip_paths,
      fs::save_paste,
      fs::code_blocks,
      hooks::gateway_info,
      watch::fs_watch_dirs,
      watch::fs_unwatch,
      preview::preview_open,
      preview::preview_navigate,
      preview::preview_rect,
      preview::preview_visible,
      preview::preview_close,
      preview::preview_mode,
      preview::preview_capture,
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
      watch::watch_prompts(app.handle().clone());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
