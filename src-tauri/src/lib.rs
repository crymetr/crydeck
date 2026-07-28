mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(pty::PtyState::default())
    .invoke_handler(tauri::generate_handler![
      pty::pty_spawn,
      pty::pty_write,
      pty::pty_resize,
      pty::pty_kill,
      pty::bench_report,
      pty::torture_dump,
      pty::torture_unicode,
      pty::torture_alt_screen,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
