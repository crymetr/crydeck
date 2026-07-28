// Phase 0 PTY spike. Throwaway. The only question it answers:
// does a Tauri + ConPTY + xterm.js terminal feel as good as Windows Terminal
// under load? If it does not, the whole Tauri plan is dead and we say so.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke, Channel } from '@tauri-apps/api/core';
import '@xterm/xterm/css/xterm.css';

// There is no devtools console to read from a headless run, so every step and
// every uncaught error goes to a file on disk instead.
const trace = (m) => {
  try { invoke('bench_report', { line: `[trace] ${m}` }); } catch (e) { /* nothing we can do */ }
};
window.addEventListener('error', (e) =>
  trace(`ERROR ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener('unhandledrejection', (e) =>
  trace(`REJECT ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
trace('boot: module loaded');

const term = new Terminal({
  // Codex: cap scrollback or memory grows without bound under a big dump.
  scrollback: 10000,
  fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  cursorBlink: true,
  allowProposedApi: true,
  // Do not let xterm write the clipboard on the terminal's say-so.
  theme: { background: '#0d0d10', foreground: '#d8d8de' },
});

const fit = new FitAddon();
term.loadAddon(fit);
trace('fit addon ok');

// Unicode 11 width tables. Will still not be perfect for emoji, that is expected.
try {
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  trace('unicode11 ok');
} catch (e) {
  trace(`unicode11 FAILED: ${e.message}`);
}

term.open(document.getElementById('term'));
trace('term.open ok');

// WebGL renderer keeps the 100MB dump from pinning the CPU. Fall back silently
// if the machine or WebView refuses a context.
let webglOn = false;
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => { webgl.dispose(); webglOn = false; });
  term.loadAddon(webgl);
  webglOn = true;
  trace('webgl renderer ok');
} catch (e) {
  trace(`webgl unavailable, using dom renderer: ${e.message}`);
}

fit.fit();
trace(`fit done: ${term.cols}x${term.rows}`);

// ---------------------------------------------------------------- stats

const stats = {
  bytes: 0,        // total bytes received from the pty
  msgs: 0,         // channel messages (should be far lower than chunks)
  lastBytes: 0,
  bps: 0,
  writeQueue: 0,   // xterm write backlog, the real lag signal
  maxQueue: 0,
  startedAt: 0,
};

const statsEl = document.getElementById('stats');

// Benchmark state: a run is "finished" once bytes stop arriving AND xterm has
// drained its write queue. Queue drain is the honest end point, not last byte in.
let bench = null;
let idleTicks = 0;

setInterval(() => {
  stats.bps = stats.bytes - stats.lastBytes;
  stats.lastBytes = stats.bytes;
  const mb = (stats.bytes / 1048576).toFixed(1);
  const mbps = (stats.bps / 1048576).toFixed(1);
  statsEl.textContent =
    `${mb}MB  ${mbps}MB/s  msgs ${stats.msgs}  queue ${stats.writeQueue}` +
    ` (max ${stats.maxQueue})  ${term.cols}x${term.rows}  ${webglOn ? 'webgl' : 'dom'}`;

  if (bench) {
    if (stats.bps === 0 && stats.writeQueue === 0) {
      idleTicks += 1;
      // two consecutive quiet ticks, so a stall mid-dump is not read as done
      if (idleTicks >= 2 && stats.bytes > 1048576) {
        const secs = (performance.now() - bench.t0) / 1000 - 1.0; // minus the idle detect
        const total = stats.bytes / 1048576;
        const line =
          `[bench] ${bench.name}: ${total.toFixed(1)}MB in ${secs.toFixed(1)}s ` +
          `= ${(total / secs).toFixed(1)}MB/s | ipc msgs ${stats.msgs} ` +
          `(avg ${(stats.bytes / stats.msgs / 1024).toFixed(0)}KB/msg) | max queue ${stats.maxQueue}`;
        console.log(line);
        term.write(`\r\n\x1b[36m${line}\x1b[0m\r\n`);
        invoke('bench_report', { line });
        bench = null;
        idleTicks = 0;
      }
    } else {
      idleTicks = 0;
    }
  }
}, 500);

// ---------------------------------------------------------------- pty wiring

let sessionId = null;
const decoder = new TextDecoder('utf-8', { fatal: false });

// Rust batches PTY reads (8-16ms / 16-64KB) and sends them as raw bytes, so one
// channel message carries many reads. One message per read would melt the IPC bridge.
const onOutput = new Channel();
onOutput.onmessage = (msg) => {
  const bytes = msg instanceof ArrayBuffer ? new Uint8Array(msg)
    : (ArrayBuffer.isView(msg) ? new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
    : new Uint8Array(msg));
  if (stats.msgs === 0) trace(`first pty output: ${bytes.byteLength} bytes`);
  stats.bytes += bytes.byteLength;
  stats.msgs += 1;
  stats.writeQueue += 1;
  if (stats.writeQueue > stats.maxQueue) stats.maxQueue = stats.writeQueue;
  // stream: true so a multi-byte codepoint split across batches survives.
  term.write(decoder.decode(bytes, { stream: true }), () => { stats.writeQueue -= 1; });
};

async function spawn(cmd, args) {
  if (sessionId !== null) await invoke('pty_kill', { id: sessionId }).catch(() => {});
  stats.bytes = 0; stats.msgs = 0; stats.lastBytes = 0;
  stats.writeQueue = 0; stats.maxQueue = 0;
  term.reset();
  trace(`spawning ${cmd} at ${term.cols}x${term.rows}`);
  try {
    sessionId = await invoke('pty_spawn', {
      cmd,
      args: args ?? [],
      cwd: 'C:\\dev',
      cols: term.cols,
      rows: term.rows,
      onOutput,
    });
    trace(`spawned session id=${sessionId}`);
  } catch (e) {
    trace(`pty_spawn FAILED: ${e}`);
    throw e;
  }
  term.focus();
}

// Keystrokes straight through. Ctrl-C is the byte 0x03 that xterm already
// produces here, NOT a Win32 console control event.
term.onData((d) => {
  if (sessionId === null) return;
  invoke('pty_write', { id: sessionId, data: d });
});

// Codex: debounce resize, drop zero/duplicate sizes. The WebView emits transient
// garbage sizes during layout and ConPTY apps redraw badly when fed them.
let resizeTimer = null;
let lastSize = '';
function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fit.fit();
    const { cols, rows } = term;
    if (cols < 2 || rows < 2) return;
    const key = `${cols}x${rows}`;
    if (key === lastSize) return;
    lastSize = key;
    if (sessionId !== null) invoke('pty_resize', { id: sessionId, cols, rows });
  }, 40);
}
new ResizeObserver(scheduleResize).observe(document.getElementById('term'));
window.addEventListener('resize', scheduleResize);

// Bracketed paste via Ctrl+Shift+V. Browser clipboard is focus sensitive, so we
// own this rather than hoping the WebView does the right thing.
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
    navigator.clipboard.readText().then((text) => {
      if (sessionId !== null && text) invoke('pty_write', { id: sessionId, data: text });
    });
    return false;
  }
  if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel);
    return false;
  }
  return true;
});

// ---------------------------------------------------------------- torture

document.getElementById('t-dump').onclick = () => {
  stats.bytes = 0; stats.lastBytes = 0; stats.msgs = 0; stats.maxQueue = 0;
  idleTicks = 0;
  bench = { name: '100MB dump', t0: performance.now() };
  trace(`dump requested on session ${sessionId}`);
  invoke('torture_dump', { id: sessionId, megabytes: 100 })
    .then((p) => trace(`dump file ready: ${p}`))
    .catch((e) => trace(`torture_dump FAILED: ${e}`));
};

document.getElementById('t-unicode').onclick = () =>
  invoke('torture_unicode', { id: sessionId });

document.getElementById('t-alt').onclick = () =>
  invoke('torture_alt_screen', { id: sessionId });

document.getElementById('t-claude').onclick = () => spawn('claude', []);

document.getElementById('t-reset').onclick = () => spawn('powershell.exe', ['-NoLogo']);

// Boot into a plain shell so the window is useful the moment it opens, then fire
// the dump automatically. Spike-only: it means the throughput number exists
// without anyone sitting there clicking a button.
spawn('powershell.exe', ['-NoLogo']).then(() => {
  setTimeout(() => document.getElementById('t-dump').click(), 2500);
});
