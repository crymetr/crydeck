import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Never watch the Rust side: during `tauri dev`, cargo holds a lock on
    // target/debug/deps/app_lib.dll and vite's file watcher crashes with EBUSY
    // the moment it tries to watch it. The frontend never imports from here.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: true,
  },
});
