mod consult;
mod fs;
mod hooks;
mod preview;
mod pty;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();
  // Must be the first plugin. A second CryDeck would bind the next gateway port
  // and rewrite gateway.json + the hook commands in ~/.claude/settings.json to
  // itself; once it closed, the CLI and the status/tool/prompt hooks pointed at
  // a dead port. Now the second launch hands its folder argument to the running
  // window and exits. Release builds only, so `tauri dev` still starts while
  // the installed CryDeck is open.
  #[cfg(not(debug_assertions))]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
    use tauri::{Emitter, Manager};
    if let Some(w) = app.get_webview_window("main") {
      let _ = w.unminimize();
      let _ = w.show();
      let _ = w.set_focus();
    }
    let dir = argv
      .get(1)
      .map(|a| std::path::Path::new(&cwd).join(a))
      .filter(|p| p.is_dir())
      .map(|p| p.to_string_lossy().to_string());
    if let Some(d) = dir {
      let _ = app.emit("cockpit-open", d);
    }
  }));
  builder
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
      pty::pty_alive,
      fs::run_setup_window,
      consult::copilot_config_get,
      consult::copilot_config_set,
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
      fs::set_output_style,
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
