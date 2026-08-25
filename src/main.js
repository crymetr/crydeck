// Cockpit frontend. One module on purpose: the app is a coordinator between
// four panes and a PTY, and splitting it into files would manufacture
// indirection, not structure. Design v2 in PLAN.md is the spec.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartIsEnabled } from '@tauri-apps/plugin-autostart';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { marked } from 'marked';
import { getVersion } from '@tauri-apps/api/app';
import changelogRaw from '../CHANGELOG.md?raw';
import '@xterm/xterm/css/xterm.css';

const MAX_SESSIONS = 10;
const trace = (m) => { try { invoke('bench_report', { line: `[ui ${new Date().toISOString().slice(11, 23)}] ${m}` }); } catch {} };
window.addEventListener('error', (e) => trace(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) =>
  trace(`REJECT ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

const $ = (id) => document.getElementById(id);
const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
// Windows path -> file:// URL the preview webview can load (C:\a b\i.html ->
// file:///C:/a%20b/i.html). Relative assets resolve against it, so a static
// page renders like a browser without any server.
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/'));
const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let gw = null;                 // { port, init_ps1, settings_json }
const sessions = new Map();    // ptyId -> session
let active = null;             // session or null

// --------------------------------------------------------- model / effort
// Claude Code takes --model/--effort at launch and /model, /effort in-session,
// so one picker drives both: new tabs get the flags, the live tab gets the
// slash commands typed into it. Every id below was launched once and checked
// against the session transcript, so none of them silently fall back to
// another model. `m1` marks the ones that accept the [1m] long-context suffix
// (Haiku does not).
const MODELS = [
  { id: '', label: 'Default', note: 'from ~\\.claude\\settings.json' },
  { id: 'claude-opus-5', label: 'Opus 5', m1: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', m1: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', m1: true },
  { id: 'claude-fable-5', label: 'Fable 5', m1: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', m1: false },
];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const prefModel = () => MODELS.find((m) => m.id === localStorage.getItem('cockpit.model')) || MODELS[0];
const prefEffort = () => {
  const e = localStorage.getItem('cockpit.effort') || '';
  return EFFORTS.includes(e) ? e : '';
};
const pref1m = () => localStorage.getItem('cockpit.model1m') === '1';

// The exact --model / /model argument: id plus the [1m] suffix when the model
// supports it and the toggle is on.
function modelArg() {
  const m = prefModel();
  return m.id && m.m1 && pref1m() ? `${m.id}[1m]` : m.id;
}

function launchFlags() {
  const m = modelArg(), e = prefEffort();
  return (m ? `--model "${m}" ` : '') + (e ? `--effort ${e} ` : '');
}

function modelBtnLabel() {
  const m = prefModel(), e = prefEffort();
  const one = m.id && m.m1 && pref1m() ? ' 1M' : '';
  return `${m.label}${one}${e ? ' · ' + e : ''}`;
}

// Type a slash command into the live session. Default (empty) selections have
// no in-session equivalent, so they only take effect on the next tab.
function typeToActive(cmd) {
  if (active?.ptyId) invoke('pty_write', { id: active.ptyId, data: `${cmd}\r` }).catch(() => {});
}

function paintModelBtn() {
  const b = $('modelbtn');
  if (b) b.textContent = modelBtnLabel();
}

function showModelMenu(btn) {
  $('modelmenu')?.remove();
  const r = btn.getBoundingClientRect();
  const panel = document.createElement('div');
  panel.id = 'modelmenu';
  panel.style.top = `${r.bottom + 4}px`;
  panel.style.right = `${Math.max(6, window.innerWidth - r.right)}px`;

  const paint = () => {
    panel.innerHTML = '';
    const sec = (t) => {
      const h = document.createElement('div');
      h.className = 'mm-h';
      h.textContent = t;
      panel.appendChild(h);
    };

    sec('Model');
    for (const m of MODELS) {
      const row = document.createElement('div');
      row.className = 'mm-row' + (m.id === prefModel().id ? ' on' : '');
      row.innerHTML = `<span class="mm-tick">${m.id === prefModel().id ? '✓' : ''}</span>` +
        `<span>${esc(m.label)}</span>` + (m.note ? `<span class="mm-note">${esc(m.note)}</span>` : '');
      row.onclick = () => {
        localStorage.setItem('cockpit.model', m.id);
        if (m.id) typeToActive(`/model ${modelArg()}`);
        paintModelBtn(); paint();
      };
      panel.appendChild(row);
    }

    const one = document.createElement('div');
    one.className = 'mm-row' + (pref1m() ? ' on' : '') + (prefModel().m1 ? '' : ' off');
    one.innerHTML = `<span class="mm-tick">${pref1m() ? '✓' : ''}</span><span>1M context</span>` +
      (prefModel().m1 ? '' : '<span class="mm-note">not on this model</span>');
    one.onclick = () => {
      localStorage.setItem('cockpit.model1m', pref1m() ? '' : '1');
      if (prefModel().id) typeToActive(`/model ${modelArg()}`);
      paintModelBtn(); paint();
    };
    panel.appendChild(one);

    sec('Effort');
    const chips = document.createElement('div');
    chips.className = 'mm-chips';
    for (const e of EFFORTS) {
      const c = document.createElement('button');
      c.className = 'mm-chip' + (e === prefEffort() ? ' on' : '');
      c.textContent = e || 'default';
      c.onclick = () => {
        localStorage.setItem('cockpit.effort', e);
        if (e) typeToActive(`/effort ${e}`);
        paintModelBtn(); paint();
      };
      chips.appendChild(c);
    }
    panel.appendChild(chips);

    const foot = document.createElement('div');
    foot.className = 'mm-foot';
    foot.textContent = 'Applies to the active session now, and to every new session. ' +
      'Default only takes effect on the next session.';
    panel.appendChild(foot);
  };

  paint();
  document.body.appendChild(panel);
  const kill = () => { panel.remove(); window.removeEventListener('pointerdown', onDown, true); };
  const onDown = (e) => { if (!panel.contains(e.target) && e.target !== btn) kill(); };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { kill(); window.removeEventListener('keydown', onKey); }
  });
}

// ------------------------------------------------------------------ sessions

// Ctrl+V / Ctrl+Shift+V paste, Ctrl+C / Ctrl+Shift+C copy when a selection
// exists (plain Ctrl+C still reaches the shell as SIGINT otherwise), and
// right-click pastes directly. term.paste() goes through xterm so bracketed
// paste mode is honored.
function wireClipboard(term, box) {
  // Wiring is idempotent: a second call on the same box would stack another
  // contextmenu listener and paste twice per right-click.
  if (box.dataset.clipWired) return;
  box.dataset.clipWired = '1';
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey) return true;
    if (ev.code === 'KeyV') {
      // preventDefault matters: without it the browser ALSO delivers a native
      // paste to xterm's textarea and the text lands twice.
      ev.preventDefault();
      smartPaste(term, ev.isTrusted ? 'ctrl-v' : 'ctrl-v-synthetic');
      return false;
    }
    if (ev.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel); return false; }
      return true;
    }
    return true;
  });
  box.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    smartPaste(term, 'contextmenu');
  });
  // THE right-click double-paste: WebView2 answers a right-click by issuing a
  // native paste command to xterm's hidden textarea, which xterm handles on its
  // own and writes to the pty — a second paste that arrives up to ~1s after our
  // contextmenu one, so a short cooldown never caught it and it went through
  // xterm, not smartPaste. Swallow every native paste in the capture phase so
  // smartPaste (Ctrl+V and right-click) is the only thing that ever pastes.
  //
  // v0.18.3: swallowing the 'paste' event alone wasn't enough — the delayed
  // native paste can also land as an editing command straight into xterm's
  // textarea (beforeinput/textInput/input with insertFromPaste), which never
  // fires a 'paste' event, and xterm's input handler forwards it to the pty.
  // Block every paste-shaped insertion path; typed keys and IME composition
  // use different inputTypes and pass through untouched.
  const pasteTypes = new Set(['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop']);
  const swallow = (ev, tag) => {
    ev.preventDefault();
    ev.stopPropagation();
    trace(`swallowed native paste via ${tag} (type=${ev.inputType || ev.type})`);
  };
  box.addEventListener('paste', (ev) => swallow(ev, 'paste'), true);
  box.addEventListener('beforeinput', (ev) => {
    if (pasteTypes.has(ev.inputType)) swallow(ev, 'beforeinput');
    else if (Date.now() - pasteDone < 5000 && (ev.data || '').length > 1)
      trace(`multi-char beforeinput passed through (type=${ev.inputType} len=${ev.data.length})`);
  }, true);
  // textInput has no inputType so it can't be told apart from IME/emoji-panel
  // input by shape — only swallow it in the few seconds after one of our own
  // paste triggers, which is when WebView2's delayed duplicate shows up.
  box.addEventListener('textInput', (ev) => {
    if (Date.now() - pasteDone < 3000) swallow(ev, 'textInput');
  }, true);
  // Last line of defense: if an insertion still got through beforeinput
  // uncancelled, stop it from reaching xterm's input handler and wipe it.
  box.addEventListener('input', (ev) => {
    if (!pasteTypes.has(ev.inputType)) return;
    ev.stopPropagation();
    if (ev.target && 'value' in ev.target) ev.target.value = '';
    trace(`swallowed native paste via input (late), textarea cleared`);
  }, true);
}

// One trigger, one paste. doPaste is async (clipboard IPC, image save), so a
// duplicated right-click event used to start a second run before the first had
// written anything and the text landed twice. Single-flight plus a short
// cooldown makes that impossible whatever fires the duplicate.
const quotePath = (p) => (p.includes(' ') ? `"${p}"` : p);
let pasteBusy = false;
let pasteDone = 0;

// v0.18.4 — kill the right-click duplicate at the LAST hop instead of guessing
// DOM paths. The v0.18.3 traps (paste/beforeinput/textInput/input) never fired:
// the log showed one clean "paste via contextmenu" and the text still landed
// twice, so WebView2's replay reaches xterm without touching any of those
// events. Every byte headed to the pty goes through term.onData, so dedup
// there: each term.paste() arms its payload as expected-once; an identical
// multi-char chunk arriving again within 3s is the replay and gets dropped.
// Compare on xterm's paste normalization (\r\n -> \r) and ignore bracketed
// paste wrappers so it matches whichever form the replay takes.
const pasteNorm = (t) => t.replace(/\r?\n/g, '\r');
const BRACKETED = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
let expectPaste = { text: '', allowed: 0, at: 0 };
function armPaste(text) {
  const t = pasteNorm(text);
  if (expectPaste.text === t && Date.now() - expectPaste.at < 3000) expectPaste.allowed++;
  else expectPaste = { text: t, allowed: 1, at: Date.now() };
}
function guardData(d) {
  if (d.length < 2 || Date.now() - expectPaste.at > 3000) return d;
  const core = pasteNorm((BRACKETED.exec(d) || [, d])[1]);
  if (core !== expectPaste.text) return d;
  if (expectPaste.allowed > 0) { expectPaste.allowed--; return d; }
  trace(`dropped duplicate paste at onData (${d.length}B)`);
  return null;
}
async function smartPaste(term, src = '?') {
  if (pasteBusy || Date.now() - pasteDone < 250) { trace(`paste via ${src} skipped (busy/cooldown)`); return; }
  trace(`paste via ${src}`);
  pasteBusy = true;
  try { await doPaste(term); }
  finally { pasteBusy = false; pasteDone = Date.now(); }
}

// Paste whatever the clipboard actually holds: Explorer-copied files paste as
// their paths, a copied image (screenshot) is saved under ~\.crydeck\pastes and
// its path pasted so Claude can read it, plain text pastes as text.
//
// Order is by cost: files (fast IPC) then text (fast) then image. Text used to
// sit behind navigator.clipboard.read(), which in WebView2 takes ~1s, so every
// plain paste lagged a second; readText() returns right away, so only an actual
// image pays the read() cost now.
async function doPaste(term) {
  const put = (x) => { armPaste(x); term.paste(x); };
  const paths = await invoke('clip_paths').catch(() => []);
  if (paths.length) { put(paths.map(quotePath).join(' ') + ' '); return; }
  const t = await navigator.clipboard.readText().catch(() => '');
  if (t) { put(t); return; }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      const ext = type.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const path = await invoke('save_paste', { name: `paste.${ext}`, b64 });
      armPaste(quotePath(path) + ' ');
      term.paste(quotePath(path) + ' ');
      return;
    }
  } catch {}
}

// First-run prerequisite installer, emitted as a single PowerShell line typed
// into the setup tab. Built for a stock, fresh machine and someone who has
// never done this: self-correcting (each tool is guarded by Get-Command so
// re-running is harmless), git falls back from winget to the direct installer
// when winget is absent (common on clean/home Windows), and — the point of the
// whole thing — it is loud, not silent. On a slow connection a silent step
// looks frozen, so every step announces itself, downloads show a live progress
// bar, the Git installer runs visibly, and a final summary confirms both tools
// or names exactly what failed.
function setupScript(launch) {
  const say = (msg, color) => `Write-Host '[CryDeck] ${msg}' -f ${color}`;
  // PowerShell 7. Without it CryDeck falls back to Windows PowerShell 5.1, which
  // renders a dead black terminal under ConPTY on some machines. Installing it
  // makes a fresh box behave like a dev box (where pwsh is already present).
  // winget first; otherwise the direct MSI from GitHub, installed silently.
  const pwshInstall =
    `if(-not(Get-Command pwsh -EA SilentlyContinue)){` +
      `if(Get-Command winget -EA SilentlyContinue){` +
        `${say('Installing PowerShell 7 via winget...', 'Cyan')};` +
        `winget install --id Microsoft.PowerShell -e --accept-package-agreements --accept-source-agreements` +
      `}else{` +
        `${say('winget not found - downloading the PowerShell 7 installer directly.', 'Yellow')};` +
        `try{` +
          `$o="$env:TEMP\\pwsh-setup.msi";` +
          `$r=irm https://api.github.com/repos/PowerShell/PowerShell/releases/latest;` +
          `$u=($r.assets|?{$_.name -match 'win-x64\\.msi$'}|select -f 1).browser_download_url;` +
          `${say('Downloading PowerShell 7... progress shows at the top.', 'Cyan')};` +
          `iwr $u -OutFile $o;` +
          `${say('Installing PowerShell 7 (silent)...', 'Cyan')};` +
          `Start-Process msiexec.exe -ArgumentList '/i',(('\"'+$o+'\"')),'/qn','/norestart' -Wait;` +
          `${say('PowerShell 7 installed.', 'Green')}` +
        `}catch{${say('PowerShell 7 install failed: $_', 'Red')}}` +
      `}` +
    `}else{${say('PowerShell 7 already installed - skipping.', 'DarkGray')}}`;
  const gitInstall =
    `if(-not(Get-Command git -EA SilentlyContinue)){` +
      `if(Get-Command winget -EA SilentlyContinue){` +
        `${say('Installing Git via winget (its progress shows below)...', 'Cyan')};` +
        `winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements` +
      `}else{` +
        `${say('winget not found - downloading the Git installer directly.', 'Yellow')};` +
        `try{` +
          `$o="$env:TEMP\\git-setup.exe";` +
          `$r=irm https://api.github.com/repos/git-for-windows/git/releases/latest;` +
          `$u=($r.assets|?{$_.name -match '64-bit\\.exe$'}|select -f 1).browser_download_url;` +
          `${say('Downloading Git... a progress bar shows at the top; slow connections can take a minute.', 'Cyan')};` +
          // Leave the progress bar on (do NOT use -UseBasicParsing) so a slow
          // download visibly ticks instead of looking frozen.
          `iwr $u -OutFile $o;` +
          `${say('Download done. Launching the Git installer - click through it if it opens a window.', 'Cyan')};` +
          `Start-Process $o -ArgumentList '/SILENT','/NORESTART' -Wait;` +
          `${say('Git installer finished.', 'Green')}` +
        `}catch{${say('Git install failed: $_', 'Red')}}` +
      `}` +
    `}else{${say('Git already installed - skipping.', 'DarkGray')}}`;
  const claudeInstall =
    `if(-not(Get-Command claude -EA SilentlyContinue)){` +
      `${say('Installing Claude Code (its output shows below)...', 'Cyan')};` +
      `try{irm https://claude.ai/install.ps1 | iex}` +
      `catch{${say('Claude Code install failed: $_', 'Red')}}` +
    `}else{${say('Claude Code already installed - skipping.', 'DarkGray')}}`;
  // The Claude Code installer drops claude.exe in %USERPROFILE%\.local\bin but
  // does NOT add that to PATH — it only prints a "add it yourself" note. So the
  // freshly installed claude is invisible to Get-Command and the whole setup
  // looked like it failed. Persist that dir to the User PATH ourselves (once),
  // so both this session and every future launch's env_check can see claude.
  const claudePath =
    `$b=Join-Path $env:USERPROFILE '.local\\bin';` +
    `if(Test-Path (Join-Path $b 'claude.exe')){` +
      `$u=[Environment]::GetEnvironmentVariable('Path','User');` +
      `if($u -notlike ('*'+$b+'*')){` +
        `[Environment]::SetEnvironmentVariable('Path',($u.TrimEnd(';')+';'+$b),'User');` +
        `${say('Added Claude Code to your PATH.', 'Cyan')}` +
      `}` +
    `}`;
  const refresh =
    `$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')`;
  // Final summary: print the actual git/claude versions, or a red line naming
  // what is still missing, so the user never has to guess whether it worked.
  // Only launch claude when it truly resolves — never fire a no-op command.
  // pwsh is installed but the running CryDeck captured its PATH at launch and
  // still spawns the 5.1 fallback — a restart is needed for the upgraded
  // terminal to take effect, so say so explicitly when we just installed it.
  const finish =
    `${say('----- Setup summary -----', 'White')};` +
    `if(Get-Command pwsh -EA SilentlyContinue){${say('PowerShell 7 OK. Restart CryDeck once so terminals use it (fixes the black screen).', 'Green')}}` +
    `else{${say('PowerShell 7 is still MISSING - terminals may render black until it is installed.', 'Red')}};` +
    `if(Get-Command git -EA SilentlyContinue){${say('Git OK: ', 'Green')};git --version}` +
    `else{${say('Git is still MISSING.', 'Red')}};` +
    `if(Get-Command claude -EA SilentlyContinue){` +
      `${say('Claude Code OK - starting it now. Log in when it asks.', 'Green')};${launch}` +
    `}else{` +
      `${say('Claude Code is still MISSING. Read the messages above, then close and reopen CryDeck to retry.', 'Red')}` +
    `}`;
  // The setup tab lands in Windows PowerShell 5.1 when pwsh is absent (a fresh
  // machine), and 5.1 does not negotiate TLS 1.2 by default — so the GitHub
  // API and install.ps1 fetches fail with an SSL/TLS error out of the box.
  // Enabling TLS 1.2 (not disabling validation) is the correct fix and is a
  // no-op on modern PowerShell.
  const tls = `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12`;
  const banner = say('Starting one-time setup. Watch this tab - each step reports below.', 'Cyan');
  return `$ErrorActionPreference='Continue'; ${banner}; ${tls}; ${pwshInstall}; ${gitInstall}; ${claudeInstall}; ${claudePath}; ${refresh}; ${finish}`;
}

async function newSession(cwd, opts = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    uiConfirm(`Session cap is ${MAX_SESSIONS}. Close a tab first.`, 'OK');
    return null;
  }
  const term = new Terminal({
    scrollback: 10000,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    theme: { background: '#0d0d10', foreground: '#d8d8de' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new UnicodeGraphemesAddon()); } catch {}

  const box = document.createElement('div');
  box.className = 'termbox';
  $('termhost').appendChild(box);
  term.open(box);
  // WebGL contexts get dropped on aggressive window resizes; losing one used
  // to blank the terminal until the next repaint. Recreate immediately and
  // force a repaint — the old 500ms delay made the whole screen strobe
  // blank/back while dragging the window edge.
  const attachWebgl = () => {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        setTimeout(() => { attachWebgl(); term.refresh(0, Math.max(0, term.rows - 1)); }, 50);
      });
      term.loadAddon(webgl);
    } catch (e) { trace(`webgl off: ${e.message}`); }
  };
  attachWebgl();

  const s = {
    ptyId: null, cwd, term, fit, box,
    decoder: new TextDecoder('utf-8', { fatal: false }),
    changed: new Set(),      // norm paths Claude edited this session
    seen: new Set(),         // subset of changed the user has opened since
    gitDirty: new Set(),     // uncommitted paths (decoration, refreshed with tree)
    feed: [],                // { kind:'url'|'file', value, at }
    seenUrls: new Set(),
    status: null, statusAt: 0,
    pvMode: 'feed', pvFile: null,
    pages: [], pageIdx: -1, previewOpen: false, pickOn: false, annOn: false,
    shells: [], shellIdx: -1, shellsOpen: false,
    tasks: [],               // { prompt, at, files:Set(norm), reviewed } — the review queue
    tree: null,              // built lazily below
    tabEl: null, lastSize: '',
  };

  const onOutput = new Channel();
  onOutput.onmessage = (msg) => {
    const bytes = msg instanceof ArrayBuffer ? new Uint8Array(msg)
      : (ArrayBuffer.isView(msg) ? new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
      : new Uint8Array(msg));
    const text = s.decoder.decode(bytes, { stream: true });
    s.term.write(text);
    scanUrls(s, text);
    // Four-state tab badge for a background session:
    //   working (blue pulse)  output is flowing
    //   done    (amber)       output went quiet after working
    //   blocked (red pulse)   Claude rang the bell — permission or waiting on you
    //   idle    (no badge)    nothing happening
    // A BEL means blocked and wins over plain output in the same chunk; any
    // other output means working (Claude resumed), clearing done/blocked.
    s.lastOut = Date.now();
    if (s !== active && s.tabEl) {
      if (text.includes('\x07')) {
        s.tabEl.classList.remove('busy', 'attn');
        s.tabEl.classList.add('blocked');
        notifyAttn(s);
      } else {
        s.tabEl.classList.remove('blocked', 'attn');
        s.tabEl.classList.add('busy');
      }
    }
  };

  const args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${gw.init_ps1}'`];
  const spawnOpts = (cmd) => ({ cmd, args, cwd, cols: s.term.cols || 100, rows: s.term.rows || 30, onOutput });
  try {
    s.ptyId = await invoke('pty_spawn', spawnOpts('pwsh.exe'));
  } catch (e1) {
    trace(`pwsh spawn failed (${e1}), falling back to powershell`);
    s.ptyId = await invoke('pty_spawn', spawnOpts('powershell.exe'));
  }
  sessions.set(s.ptyId, s);

  s.term.onData((d) => { const g = guardData(d); if (g !== null) invoke('pty_write', { id: s.ptyId, data: g }); });
  wireClipboard(s.term, s.box);

  // A tab IS a Claude session: launch it once the shell has settled, with
  // Remote Control on so the phone can pick any session up. Closing the app
  // kills the processes (by design), not the conversations.
  //
  // Restore resumes by session id, not `--continue`: `--continue` means "the
  // last conversation in this folder", so five tabs on one folder all came
  // back as the same conversation. The id is the one the hooks bound to the
  // tab; without one (older saved state, a tab that never ran a hook) it falls
  // back to the folder's last conversation.
  // The id goes onto a shell command line, so only a plain uuid-shaped token is
  // allowed through; anything else falls back rather than typing junk.
  const sid = /^[A-Za-z0-9-]{8,64}$/.test(opts.sid || '') ? opts.sid : null;
  const resume = sid ? `--resume ${sid} ` : (opts.resume ? '--continue ' : '');
  setTimeout(() => {
    if (!sessions.has(s.ptyId)) return;
    const launch = `claude ${resume}${launchFlags()}--remote-control "${basename(cwd)}"`;
    if (opts.setup) {
      // First run with missing prerequisites: install them right here in the
      // tab, refresh PATH so this same shell sees the new binaries, then fall
      // through into claude (its first launch walks the user through login).
      // Runtime Get-Command guards make this self-correcting and idempotent:
      // winget is missing on plenty of stock/home Windows installs, so git
      // falls back to the direct git-for-windows installer (asset resolved via
      // the GitHub API so it never 404s on a version bump). Every branch
      // prints what it is doing so a stuck step is visible instead of silent.
      trace(`setup script typed into session ${s.ptyId}`);
      invoke('pty_write', { id: s.ptyId, data: setupScript(launch) + '\r' });
    } else {
      invoke('pty_write', { id: s.ptyId, data: `${launch}\r` });
      // Seeded prompt from `crydeck spawn <folder> <prompt>`: give Claude a few
      // seconds to finish launching, then type the first message into it.
      if (opts.seed) {
        const seed = opts.seed;
        setTimeout(() => {
          if (sessions.has(s.ptyId)) invoke('pty_write', { id: s.ptyId, data: `${seed}\r` });
        }, 6000);
      }
    }
  }, 2500);

  s.tree = buildTree(s);

  // Claude Code narrates what it is doing through the terminal title escape.
  // That belongs on the tab, not on the window (where it painted over the
  // titlebar as clipped garbage).
  s.term.onTitleChange((t) => {
    if (!s.tabEl) return;
    const name = t && t.trim() ? t.trim() : basename(s.cwd);
    s.tabEl.querySelector('.name').textContent = name;
    s.tabEl.title = `${s.cwd}\n${name}`;
  });

  makeTab(s);
  activate(s);
  persistTabs();
  trace(`session ${s.ptyId} at ${cwd}`);
  return s;
}

function closeSession(s) {
  cancelAutoCont(s);
  invoke('pty_kill', { id: s.ptyId }).catch(() => {});
  invoke('fs_unwatch', { tab: s.ptyId }).catch(() => {});
  sessions.delete(s.ptyId);
  invoke('preview_close', { tab: s.ptyId }).catch(() => {});
  for (const sh of s.shells) {
    invoke('pty_kill', { id: sh.ptyId }).catch(() => {});
    sh.term.dispose();
    sh.box.remove();
  }
  s.term.dispose();
  s.box.remove();
  s.tabEl.remove();
  s.tree.el.remove();
  if (active === s) {
    active = null;
    const rest = [...sessions.values()];
    if (rest.length) activate(rest[rest.length - 1]);
    else renderEmpty();
  }
  persistTabs();
}

function activate(s) {
  active = s;
  for (const o of sessions.values()) {
    o.box.classList.toggle('active', o === s);
    o.tabEl?.classList.toggle('active', o === s);
    if (o === s) { o.tabEl?.classList.remove('busy', 'attn', 'blocked'); o.notified = false; }
    o.tree.el.style.display = o === s ? '' : 'none';
    if (o !== s) invoke('preview_visible', { tab: o.ptyId, visible: false, rect: null }).catch(() => {});
  }
  $('empty')?.remove();
  if (s.treeDirty) { s.treeDirty = false; s.tree.refresh(); }
  requestAnimationFrame(() => { fitActive(); s.term.focus(); });
  setPvMode(s.pvMode, true);
  renderShells(s);
  reviewChanged(s);
  renderStatus();
}

function fitActive() {
  if (!active) return;
  active.fit.fit();
  // Force a repaint: resizes occasionally leave the canvas blank otherwise.
  active.term.refresh(0, Math.max(0, active.term.rows - 1));
  const { cols, rows } = active.term;
  if (cols < 2 || rows < 2) return;
  const key = `${cols}x${rows}`;
  if (key === active.lastSize) return;
  active.lastSize = key;
  invoke('pty_resize', { id: active.ptyId, cols, rows });
}
let resizeTimer = null;
const scheduleResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitActive, 40); };
new ResizeObserver(scheduleResize).observe($('termhost'));
window.addEventListener('resize', scheduleResize);

// ------------------------------------------------------------------ tabs

function makeTab(s) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = `<span class="badge"></span><span class="name">${esc(basename(s.cwd))}</span><span class="schedicon">⏱</span><button class="close" title="Close session">×</button>`;
  el.title = s.cwd;
  el.onclick = () => activate(s);
  el.oncontextmenu = (ev) => {
    ev.preventDefault();
    const items = [];
    const resetsAt = parseResetsAt(s);
    if (resetsAt && resetsAt > Date.now())
      items.push([`Auto-continue at limit reset (${new Date(resetsAt + 60000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`,
        () => setAutoCont(s, resetsAt + 60000)]);
    for (const m of [30, 45, 60])
      items.push([`Auto-continue in ${m} min`, () => setAutoCont(s, Date.now() + m * 60000)]);
    items.push(['Auto-continue in custom minutes…', () => {
      const v = parseInt(prompt('Minutes until "continue" is sent:', '45'), 10);
      if (!isNaN(v) && v > 0) setAutoCont(s, Date.now() + v * 60000);
    }]);
    if (s.autoCont)
      items.push([`Cancel auto-continue (${fmtIn(s.autoCont.at)})`, () => cancelAutoCont(s)]);
    contextMenu(ev, items);
  };
  el.querySelector('.close').onclick = (ev) => {
    ev.stopPropagation();
    closeSession(s);
  };
  $('tabs').insertBefore(el, $('newtab'));
  s.tabEl = el;
}

async function pickAndOpen() {
  const start = localStorage.getItem('cockpit.lastFolder') || 'C:\\dev';
  const folder = await invoke('pick_folder', { startDir: start });
  if (!folder) return;
  localStorage.setItem('cockpit.lastFolder', folder);
  await newSession(folder);
}

/* ---------- auto-continue scheduler (always user-set, never automatic) ---- */

function parseResetsAt(s) {
  const r = s.status?.rate_limits?.five_hour?.resets_at ?? s.status?.rate_limits?.weekly?.resets_at;
  if (r == null) return null;
  if (typeof r === 'number') return r < 1e12 ? r * 1000 : r; // seconds vs ms epoch
  const t = Date.parse(r);
  return isNaN(t) ? null : t;
}

const fmtIn = (at) => {
  const m = Math.max(0, Math.round((at - Date.now()) / 60000));
  return m >= 60 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${m}m`;
};

function setAutoCont(s, at) {
  cancelAutoCont(s);
  s.autoCont = {
    at,
    timer: setTimeout(() => {
      if (!sessions.has(s.ptyId)) return;
      invoke('pty_write', { id: s.ptyId, data: 'continue\r' });
      trace(`auto-continue fired for session ${s.ptyId}`);
      s.autoCont = null;
      s.tabEl?.classList.remove('sched');
      if (s !== active) s.tabEl?.classList.add('attn');
      renderStatus();
    }, Math.max(1000, at - Date.now())),
  };
  s.tabEl?.classList.add('sched');
  s.tabEl.querySelector('.schedicon').title = `Auto-continue ${fmtIn(at)} (${new Date(at).toLocaleTimeString('en-GB')})`;
  renderStatus();
}

function cancelAutoCont(s) {
  if (s.autoCont) clearTimeout(s.autoCont.timer);
  s.autoCont = null;
  s.tabEl?.classList.remove('sched');
  renderStatus();
}

// Saved tabs carry the Claude session id alongside the folder so each one comes
// back as its own conversation. Written on open/close and again whenever a tab
// binds a new id, so a Claude restarted mid-session is what gets restored.
function persistTabs() {
  const tabs = [...sessions.values()].map((s) => ({ cwd: s.cwd, sid: s.claudeSid || null }));
  localStorage.setItem('cockpit.tabs', JSON.stringify(tabs));
  // Keep the backend session roster (for `crydeck list`) in step with the tabs.
  // Name comes from the tab title when Claude has narrated one, else the folder.
  const roster = [...sessions.values()].map((s) => ({
    id: s.ptyId,
    name: (s.tabEl?.querySelector('.name')?.textContent || basename(s.cwd)).trim(),
    cwd: s.cwd,
  }));
  invoke('control_sync', { sessions: roster }).catch(() => {});
}

function renderEmpty() {
  if ($('empty')) return;
  const d = document.createElement('div');
  d.id = 'empty';
  d.innerHTML = `
    <div>No sessions.</div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button>Open a folder</button>
      <button id="empty-proj">Start in my Projects folder</button>
    </div>
    <div style="margin-top:14px;max-width:420px;font-size:12px;line-height:1.6;color:#8a8a94;text-align:left">
      New here? A session is Claude Code working inside one folder (a project).
      "Start in my Projects folder" creates <b>Projects</b> in your user folder
      and opens Claude there — just tell it what to build in plain words and ask
      it to make a subfolder for the project. One tab per project.
    </div>`;
  d.querySelector('button').onclick = pickAndOpen;
  d.querySelector('#empty-proj').onclick = async () => {
    const dir = await invoke('projects_dir').catch(() => null);
    if (dir) try { await newSession(dir, {}); } catch (e) { trace(`projects open failed: ${e}`); }
  };
  $('app').appendChild(d);
  renderStatus();
}

// ------------------------------------------------------------------ tree

function buildTree(s) {
  const el = document.createElement('div');
  $('tree').appendChild(el);
  const expanded = new Set();
  const nodeByPath = new Map(); // norm path -> node element
  let selected = null;

  // The watcher mirrors what the tree shows: root + expanded dirs, each
  // non-recursive. Cheap even for a tab sitting on C:\dev, and a project
  // folder Claude scaffolds under the root still appears the moment it lands.
  const syncWatch = () =>
    invoke('fs_watch_dirs', { tab: s.ptyId, dirs: [s.cwd, ...expanded] })
      .catch((e) => trace(`fs_watch_dirs failed: ${e}`));

  const hdr = document.createElement('div');
  hdr.className = 'hdr';
  hdr.innerHTML = `<span class="root">${esc(s.cwd)}</span><button title="Refresh">⟳</button>`;
  hdr.querySelector('button').onclick = () => refresh();
  el.appendChild(hdr);
  const rootKids = document.createElement('div');
  el.appendChild(rootKids);

  // Marks: amber = Claude changed it and you have not looked yet; green = you
  // opened it since the change. Folders aggregate: amber wins over green.
  function markFor(p, isDir) {
    if (isDir) {
      const np = norm(p) + '\\';
      let unseen = false, seen = false;
      for (const c of s.changed) {
        if (!c.startsWith(np)) continue;
        if (s.seen.has(c)) seen = true; else unseen = true;
      }
      if (unseen) return 'changed';
      if (seen) return 'seen';
      for (const g of s.gitDirty) if (g.startsWith(np) || g === norm(p)) return 'git';
      return null;
    }
    const np = norm(p);
    if (s.changed.has(np)) return s.seen.has(np) ? 'seen' : 'changed';
    return s.gitDirty.has(np) ? 'git' : null;
  }
  function applyMark(el, mark) {
    el.classList.toggle('changed', mark === 'changed');
    el.classList.toggle('seen', mark === 'seen');
    el.classList.toggle('git', mark === 'git');
  }
  function recomputeMarks() {
    for (const rec of nodeByPath.values()) applyMark(rec.el, markFor(rec.p, rec.isDir));
  }

  async function renderInto(container, dir) {
    let entries;
    try { entries = await invoke('fs_list', { dir }); }
    catch (e) { container.innerHTML = `<div class="row" style="color:#c66">${esc(String(e))}</div>`; return; }
    container.innerHTML = '';
    for (const en of entries) {
      const p = dir.replace(/[\\/]+$/, '') + '\\' + en.name;
      const node = document.createElement('div');
      node.className = 'node';
      applyMark(node, markFor(p, en.is_dir));
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="arrow">${en.is_dir ? '▶' : ''}</span><span class="ico">${en.is_dir ? '📁' : '📄'}</span><span class="label">${esc(en.name)}</span>`;
      node.appendChild(row);
      nodeByPath.set(norm(p), { el: node, p, isDir: en.is_dir });

      if (en.is_dir) {
        let kids = null;
        row.onclick = async () => {
          if (kids) {
            const open = kids.style.display !== 'none';
            kids.style.display = open ? 'none' : '';
            row.querySelector('.arrow').textContent = open ? '▶' : '▼';
            open ? expanded.delete(norm(p)) : expanded.add(norm(p));
            syncWatch();
          } else {
            kids = document.createElement('div');
            kids.className = 'kids';
            node.appendChild(kids);
            row.querySelector('.arrow').textContent = '▼';
            expanded.add(norm(p));
            syncWatch();
            await renderInto(kids, p);
          }
        };
        row.oncontextmenu = (ev) => {
          ev.preventDefault();
          contextMenu(ev, [
            ['Open as session', () => newSession(p)],
            ['Explorer here', () => invoke('os_explore', { path: p })],
          ]);
        };
        row.ondblclick = () => invoke('os_explore', { path: p });
        if (expanded.has(norm(p))) row.onclick();
      } else {
        row.onclick = () => {
          selected?.classList.remove('sel');
          selected = row;
          row.classList.add('sel');
          showFile(s, p);
        };
        row.ondblclick = () => invoke('os_open', { path: p });
      }
      container.appendChild(node);
    }
  }

  function refresh() {
    nodeByPath.clear();
    selected = null;
    renderInto(rootKids, s.cwd);
    syncWatch();
    invoke('git_status', { root: s.cwd }).then((list) => {
      s.gitDirty = new Set(list.map(norm));
      recomputeMarks();
    }).catch(() => {});
  }
  refresh();

  return { el, recomputeMarks, refresh };
}

// Real-time tree: the Rust watcher coalesces filesystem churn per session and
// pings us here. Background tabs just mark dirty and refresh on activation.
listen('cockpit-fs', (ev) => {
  const s = sessions.get(ev.payload.tab);
  if (!s) return;
  if (s === active) s.tree.refresh();
  else s.treeDirty = true;
});

// ------------------------------------------------------------------ preview

function setPvMode(mode, force = false) {
  if (!active) return;
  if (!force && active.pvMode === mode) return;
  active.pvMode = mode;
  for (const b of document.querySelectorAll('#pv-modes button'))
    b.classList.toggle('on', b.dataset.mode === mode);
  for (const v of document.querySelectorAll('.pv-view')) v.classList.remove('on');
  $(`pv-${mode}`).classList.add('on');
  if (mode !== 'app' && active.previewOpen)
    invoke('preview_visible', { tab: active.ptyId, visible: false, rect: null }).catch(() => {});
  if (mode === 'file' && active.pvFile) renderFile(active);
  if (mode === 'app') renderApp(active);
  if (mode === 'feed') renderFeed(active);
  if (mode === 'review') renderReview(active);
  if (mode === 'code') renderCode(active);
}

// One-click copy for code blocks, fed by the session transcript (the JSONL
// Claude Code writes as it goes) instead of scraping the terminal. Newest
// first. Light polling while the pane is visible; re-render only on change so
// scroll position and "Copied" feedback survive.
async function renderCode(s) {
  const list = document.querySelector('#pv-code .list');
  const blocks = await invoke('code_blocks', { cwd: s.cwd }).catch(() => []);
  if (s !== active || s.pvMode !== 'code') return;
  const key = s.ptyId + '|' + blocks.map((b) => b.lang + b.code.length).join('|');
  if (renderCode.domKey === key) return;
  renderCode.domKey = key;
  list.innerHTML = '';
  if (!blocks.length) {
    list.innerHTML = '<div class="feed-empty">No code blocks in this session\'s replies yet. When Claude answers with code, it shows up here with a copy button.</div>';
    return;
  }
  for (const b of blocks) {
    const el = document.createElement('div');
    el.className = 'codeblock';
    el.innerHTML = `<div class="cbhdr"><span>${esc(b.lang || 'text')}</span><button>⧉ Copy</button></div><pre></pre>`;
    el.querySelector('pre').textContent = b.code.length > 6000 ? b.code.slice(0, 6000) + '\n…' : b.code;
    const btn = el.querySelector('button');
    btn.onclick = () => {
      navigator.clipboard.writeText(b.code);
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = '⧉ Copy'; }, 1200);
    };
    list.append(el);
  }
}
setInterval(() => { if (active && active.pvMode === 'code') renderCode(active); }, 4000);
for (const b of document.querySelectorAll('#pv-modes button'))
  b.onclick = () => setPvMode(b.dataset.mode);

function diffHtml(d) {
  return d.split('\n').map((l) => {
    const e = esc(l);
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) return `<span class="dmeta">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="dhunk">${e}</span>`;
    if (l.startsWith('+')) return `<span class="dadd">${e}</span>`;
    if (l.startsWith('-')) return `<span class="ddel">${e}</span>`;
    return e;
  }).join('\n');
}

// Auto-render HTML: selecting an .html file shows the rendered page straight
// away, no Render click. On by default; toggle in the About card. Stored as
// '0' when off.
let autoRenderHtml = localStorage.getItem('cockpit.autorender') !== '0';

function showFile(s, path) {
  s.pvFile = path;
  s.pvView = null; // re-decide content-vs-diff per file
  s.pvDiff = ''; s.pvDiffFor = null; // stale diff never survives a new click
  const np = norm(path);
  if (s.changed.has(np) && !s.seen.has(np)) {
    s.seen.add(np);
    s.tree.recomputeMarks();
    reviewChanged(s);
  }
  if (s === active) {
    // PDFs ride the same slot: WebView2 has a native PDF viewer, so file://
    // into the App pane just works.
    if (autoRenderHtml && /\.(html?|pdf)$/i.test(path)) renderHtmlFile(s, path);
    else setPvMode('file', true);
  }
}

// Load an HTML file rendered into the App pane. Reuses one file:// page slot
// instead of stacking a new tab for every HTML file you click.
function renderHtmlFile(s, path) {
  const url = fileUrl(path);
  const exact = s.pages.findIndex((p) => p.url.toLowerCase() === url.toLowerCase());
  if (exact >= 0) {
    s.pageIdx = exact;
  } else {
    const fileIdx = s.pages.findIndex((p) => /^file:\/\//i.test(p.url));
    if (fileIdx >= 0) { s.pages[fileIdx] = { url }; s.pageIdx = fileIdx; }
    else { s.pageIdx = s.pages.push({ url }) - 1; }
  }
  if (s === active) setPvMode('app', true);
}

async function renderFile(s) {
  const pane = $('pv-file');
  pane.innerHTML = `<div class="path"><span class="p">${esc(s.pvFile)}</span></div><div class="content"><div class="note">loading…</div></div>`;
  // Content renders the moment it's read; the diff is decoration that attaches
  // when git answers. Blocking the viewer on a subprocess felt broken.
  const file = s.pvFile;
  let c;
  try { c = await invoke('fs_read', { path: file }); }
  catch (e) { pane.querySelector('.content').innerHTML = `<div class="note">${esc(String(e))}</div>`; return; }
  if (s !== active || s.pvMode !== 'file' || s.pvFile !== file) return;
  let diff = s.pvDiffFor === file ? s.pvDiff : '';
  if (!diff) {
    invoke('git_diff', { root: s.cwd, path: file }).then((d) => {
      if (!d || s !== active || s.pvMode !== 'file' || s.pvFile !== file) return;
      s.pvDiff = d; s.pvDiffFor = file;
      renderFile(s); // re-render, now with the Content|Diff switch available
    }).catch(() => {});
  }

  // A dirty file gets a Content|Diff switch. Content is always the landing
  // view; the diff is one click away when you want it.
  if (diff && c.kind === 'text') {
    if (s.pvView == null) s.pvView = 'content';
    const bar = document.createElement('div');
    bar.className = 'viewsel';
    for (const v of ['content', 'diff']) {
      const b = document.createElement('button');
      b.textContent = v === 'content' ? 'Content' : 'Diff';
      b.classList.toggle('on', s.pvView === v);
      b.onclick = () => { s.pvView = v; renderFile(s); };
      bar.appendChild(b);
    }
    pane.insertBefore(bar, pane.querySelector('.content'));
    if (s.pvView === 'diff') {
      const pre = document.createElement('pre');
      pre.className = 'diff';
      pre.innerHTML = diffHtml(diff);
      pane.querySelector('.content').replaceChildren(pre);
      return;
    }
  }
  const content = pane.querySelector('.content');
  // HTML files get a Render button in the header: it loads the file itself
  // (file://) into the App preview, so you see the rendered page, not the code.
  if (/\.(html?|pdf)$/i.test(file)) {
    const btn = document.createElement('button');
    btn.className = 'renderbtn';
    btn.textContent = 'Render ↗';
    btn.title = 'Show this page rendered in the App preview';
    btn.onclick = () => renderHtmlFile(s, file);
    pane.querySelector('.path').appendChild(btn);
  }
  if (c.kind === 'text') {
    const isMd = /\.(md|markdown)$/i.test(s.pvFile);
    if (isMd) {
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = marked.parse(c.text);
      // Preview is a viewer: never let a markdown link navigate the app window.
      for (const a of md.querySelectorAll('a')) a.onclick = (ev) => ev.preventDefault();
      content.replaceChildren(md);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = c.text + (c.truncated ? '\n\n… (truncated at 1MB)' : '');
      content.replaceChildren(pre);
    }
  } else if (c.kind === 'image') {
    content.innerHTML = `<img src="data:${c.mime};base64,${c.base64}" alt="" />`;
  } else if (c.kind === 'binary') {
    content.innerHTML = `<div class="note">Binary file (${fmtBytes(c.size)}). Double-click it in the tree to open in its app.</div>`;
  } else {
    content.innerHTML = `<div class="note">Too big to preview (${fmtBytes(c.size)}).</div>`;
  }
}

// The preview is a Tauri child webview parked over #pv-appbody. Child, not
// iframe, because we inject the picker/annotator script into whatever page it
// loads — an iframe can't do that cross-origin.
const curPage = (s) => (s.pageIdx >= 0 ? s.pages[s.pageIdx] : null);

function appBodyRect() {
  const r = $('pv-appbody').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

async function showPreview(s) {
  const page = curPage(s);
  if (!page) return;
  const rect = appBodyRect();
  if (rect.w < 20 || rect.h < 20) return;
  try {
    if (!s.previewOpen) {
      await invoke('preview_open', { tab: s.ptyId, url: page.url, rect });
      s.previewOpen = true;
      s.openUrl = page.url;
    } else {
      await invoke('preview_visible', { tab: s.ptyId, visible: true, rect });
      if (s.openUrl !== page.url) {
        await invoke('preview_navigate', { tab: s.ptyId, url: page.url });
        s.openUrl = page.url;
      }
    }
  } catch (e) { trace(`preview failed: ${e}`); }
}

function renderApp(s) {
  const page = curPage(s);
  $('pv-url').value = page ? page.url : '';
  document.querySelector('#pv-app .placeholder').style.display = page ? 'none' : '';
  const tabs = $('pv-pagetabs');
  tabs.classList.toggle('has', s.pages.length > 1);
  tabs.innerHTML = '';
  s.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'ptab' + (i === s.pageIdx ? ' on' : '');
    t.innerHTML = `<span>${esc(p.url.replace(/^https?:\/\//, ''))}</span><b title="Close">×</b>`;
    t.onclick = () => { s.pageIdx = i; renderApp(s); if (s === active && s.pvMode === 'app') showPreview(s); };
    t.querySelector('b').onclick = (ev) => {
      ev.stopPropagation();
      s.pages.splice(i, 1);
      if (s.pageIdx >= s.pages.length) s.pageIdx = s.pages.length - 1;
      renderApp(s);
      if (s.pages.length === 0 && s.previewOpen) {
        invoke('preview_visible', { tab: s.ptyId, visible: false, rect: null }).catch(() => {});
      } else if (s === active && s.pvMode === 'app') showPreview(s);
    };
    tabs.appendChild(t);
  });
  setModeButtons(s);
  if (s === active && s.pvMode === 'app' && page) showPreview(s);
}

function setModeButtons(s) {
  $('pv-pick').classList.toggle('on', !!s.pickOn);
  $('pv-ann').classList.toggle('on', !!s.annOn);
  $('pv-send').style.display = s.annOn ? '' : 'none';
}

function loadApp(s, url) {
  if (!/^(https?|file):\/\//i.test(url)) url = 'http://' + url;
  const i = s.pages.findIndex((p) => p.url.toLowerCase() === url.toLowerCase());
  s.pageIdx = i >= 0 ? i : s.pages.push({ url }) - 1;
  if (s === active) setPvMode('app', true);
}

// Keep the webview glued to the pane through splitter drags and resizes.
// Debounced: a splitter drag emits dozens of rects a second and each one is a
// cross-thread hop.
let rectTimer = null;
new ResizeObserver(() => {
  clearTimeout(rectTimer);
  rectTimer = setTimeout(() => {
    if (active?.previewOpen && active.pvMode === 'app' && curPage(active))
      invoke('preview_rect', { tab: active.ptyId, rect: appBodyRect() }).catch(() => {});
  }, 80);
}).observe($('pv-appbody'));

$('pv-go').onclick = () => active && $('pv-url').value.trim() && loadApp(active, $('pv-url').value.trim());
$('pv-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pv-go').click(); });
$('pv-reload').onclick = () => {
  const p = active && curPage(active);
  if (p && active.previewOpen) invoke('preview_navigate', { tab: active.ptyId, url: p.url }).catch(() => {});
};
$('pv-ext').onclick = () => {
  const p = active && curPage(active);
  if (p) invoke('os_open', { path: p.url });
};

/* ---------- element picker + annotations ---------- */

$('pv-pick').onclick = () => {
  if (!active?.previewOpen) return;
  active.pickOn = !active.pickOn;
  if (active.pickOn && active.annOn) { active.annOn = false; invoke('preview_mode', { tab: active.ptyId, mode: 'annotate', on: false }).catch(() => {}); }
  invoke('preview_mode', { tab: active.ptyId, mode: 'pick', on: active.pickOn }).catch(() => {});
  setModeButtons(active);
};
$('pv-ann').onclick = () => {
  if (!active?.previewOpen) return;
  active.annOn = !active.annOn;
  if (active.annOn && active.pickOn) { active.pickOn = false; invoke('preview_mode', { tab: active.ptyId, mode: 'pick', on: false }).catch(() => {}); }
  invoke('preview_mode', { tab: active.ptyId, mode: 'annotate', on: active.annOn }).catch(() => {});
  setModeButtons(active);
};
$('pv-send').onclick = () => {
  if (!active?.annOn) return;
  invoke('preview_mode', { tab: active.ptyId, mode: 'send_annotations', on: true }).catch(() => {});
};

listen('cockpit-select', (ev) => {
  let j; try { j = JSON.parse(ev.payload.raw); } catch { return; }
  const s = sessions.get(j.tab);
  if (!s) return;
  s.pickOn = false;
  if (s === active) setModeButtons(s);
  const msg = `Look at this element in the preview (${j.url}): ${j.selector}` +
    (j.text ? ` with text "${j.text}"` : '') +
    ` at ${j.rect?.x},${j.rect?.y} size ${j.rect?.w}x${j.rect?.h}. `;
  invoke('pty_write', { id: s.ptyId, data: msg });
  s.term.focus();
});

listen('cockpit-pickoff', (ev) => {
  let j; try { j = JSON.parse(ev.payload.raw); } catch { return; }
  const s = sessions.get(j.tab);
  if (!s) return;
  s.pickOn = false; s.annOn = false;
  if (s === active) setModeButtons(s);
});

listen('cockpit-annotate', async (ev) => {
  let j; try { j = JSON.parse(ev.payload.raw); } catch { return; }
  const s = sessions.get(j.tab);
  if (!s || !j.rects?.length) return;
  let shot = '';
  try { shot = await invoke('preview_capture', { tab: s.ptyId }); }
  catch (e) { trace(`capture failed: ${e}`); }
  const regions = j.rects.map((r, i) =>
    `${i + 1}) at ${r.x},${r.y} size ${r.w}x${r.h}${r.near ? ` near ${r.near}` : ''}`).join('; ');
  const msg = `I annotated the preview (${j.url}). Marked regions: ${regions}.` +
    (shot ? ` Read the screenshot at ${shot} — the numbered boxes are my annotations.` : '') + ' ';
  invoke('pty_write', { id: s.ptyId, data: msg });
  s.annOn = false;
  invoke('preview_mode', { tab: s.ptyId, mode: 'annotate', on: false }).catch(() => {});
  if (s === active) setModeButtons(s);
  s.term.focus();
});

// ------------------------------------------------------------------ feed

function addFeed(s, kind, value) {
  const i = s.feed.findIndex((f) => f.kind === kind && norm(f.value) === norm(value));
  if (i >= 0) s.feed.splice(i, 1);
  s.feed.unshift({ kind, value, at: Date.now() });
  if (s.feed.length > 200) s.feed.pop();
  if (s === active && s.pvMode === 'feed') renderFeed(s);
}

// Show file paths relative to the session root; URLs verbatim. Full value
// lives in the row tooltip.
function feedLabel(f) {
  if (f.kind === 'url') return f.value;
  const root = norm(active?.cwd || '');
  return norm(f.value).startsWith(root + '\\') ? f.value.slice(root.length + 1) : f.value;
}

function renderFeed(s) {
  const list = document.querySelector('#pv-feed .list');
  if (!s.feed.length) {
    list.innerHTML = `<div class="feed-empty">Nothing yet. Files Claude edits and localhost links it mentions collect here.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const f of s.feed) {
    const row = document.createElement('div');
    row.className = 'feed-item';
    const t = new Date(f.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    row.title = f.value;
    row.innerHTML = `<span class="ico">${f.kind === 'url' ? '🌐' : '📄'}</span><span class="what">${esc(feedLabel(f))}</span><span class="t">${t}</span><button class="open">${f.kind === 'url' ? 'browser' : 'OS open'}</button>`;
    row.onclick = () => f.kind === 'url' ? loadApp(s, f.value) : showFile(s, f.value);
    row.querySelector('.open').onclick = (ev) => {
      ev.stopPropagation();
      invoke('os_open', { path: f.value });
    };
    list.appendChild(row);
  }
}

const ANSI_RE = /\x1b(?:\[[0-9;:?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s'"`)\]>\x00-\x1f\x7f]*)?/gi;
function scanUrls(s, raw) {
  // TUI output is soaked in escape sequences; strip them or they end up glued
  // into the matched URL (seen live: "style.css␛[38;2;215…").
  const text = raw.replace(ANSI_RE, '');
  for (const m of text.matchAll(URL_RE)) {
    let u = m[0].replace(/[.,;:\/]+$/, '');
    const key = u.toLowerCase();
    if (s.seenUrls.has(key)) continue;
    s.seenUrls.add(key);
    addFeed(s, 'url', u);
    trace(`url detected in session ${s.ptyId}: ${u}`);
    // First dev server of the session claims the App pane automatically; later
    // URLs only join the Feed so they never hijack what you are looking at.
    if (!s.pages.length) loadApp(s, u);
  }
}

// ------------------------------------------------------------------ hooks in

// Hook payloads carry session_id + cwd; that is the tab identity. First event
// from a Claude session binds its session_id to the tab whose folder matches
// (preferring an unbound tab, so two tabs on one folder still separate);
// everything after routes by session_id alone.
function sessionForHook(j) {
  const sid = j.session_id;
  if (sid) for (const s of sessions.values()) if (s.claudeSid === sid) return s;
  const cwd = j.cwd || j.workspace?.current_dir;
  if (!cwd) return null;
  const nc = norm(cwd);
  let best = null;
  for (const s of sessions.values()) {
    if (norm(s.cwd) !== nc) continue;
    if (!s.claudeSid) { best = s; break; }
    best ??= s; // all bound: claude restarted in this tab, rebind below
  }
  // A fresh binding is also what restore needs, so save it right away.
  if (best && sid && best.claudeSid !== sid) {
    best.claudeSid = sid;
    persistTabs();
  }
  return best;
}

listen('cockpit-status', (ev) => {
  let j;
  try { j = JSON.parse(ev.payload.raw); } catch { return; }
  const s = sessionForHook(j);
  if (!s) return;
  s.status = j;
  s.statusAt = Date.now();
  if (s === active) renderStatus();
});

// `crydeck spawn <folder> [prompt]` arrives here via the gateway. Open the
// session and, if a prompt was seeded, let newSession type it once Claude is up.
listen('cockpit-spawn', async (ev) => {
  let cwd, prompt;
  try { const p = JSON.parse(ev.payload.raw); cwd = p.cwd; prompt = p.prompt; } catch { return; }
  if (!cwd) return;
  try {
    const s = await newSession(cwd, { seed: prompt && prompt.trim() ? prompt.trim() : undefined });
    if (s) activate(s);
    trace(`crydeck spawn at ${cwd}${prompt ? ' (seeded)' : ''}`);
  } catch (e) { trace(`crydeck spawn failed: ${e}`); }
});

listen('cockpit-tool', (ev) => {
  let j;
  try { j = JSON.parse(ev.payload.raw); } catch { return; }
  const s = sessionForHook(j);
  if (!s) return;
  const p = j.tool_input?.file_path || j.tool_input?.notebook_path;
  if (!p) return;
  s.changed.add(norm(p));
  s.seen.delete(norm(p)); // a re-edit makes it unread again
  s.tree.recomputeMarks();
  addFeed(s, 'file', p);
  // Attach to the current task. Edits before any prompt (auto-run, resumed
  // work) get an implicit bucket rather than being lost.
  let task = s.tasks[0];
  if (!task) {
    task = { prompt: '(work before first prompt)', at: Date.now(), files: new Map(), reviewed: false };
    s.tasks.unshift(task);
  }
  task.files.set(norm(p), p);
  task.reviewed = false;
  reviewChanged(s);
});

listen('cockpit-prompt', (ev) => {
  let j; try { j = JSON.parse(ev.payload.raw); } catch { return; }
  const s = sessionForHook(j);
  if (!s || !j.prompt) return;
  s.tasks.unshift({ prompt: String(j.prompt).slice(0, 300), at: Date.now(), files: new Map(), reviewed: false });
  if (s.tasks.length > 100) s.tasks.pop();
  reviewChanged(s);
});

/* ---------- review queue ---------- */

const taskUnseen = (s, t) => [...t.files.keys()].filter((f) => s.changed.has(f) && !s.seen.has(f)).length;

function reviewChanged(s) {
  if (s !== active) return;
  const total = s.tasks.reduce((n, t) => n + taskUnseen(s, t), 0);
  $('rv-count').textContent = total ? String(total) : '';
  if (s.pvMode === 'review') renderReview(s);
}

function renderReview(s) {
  const list = document.querySelector('#pv-review .list');
  const tasks = s.tasks.filter((t) => t.files.size);
  if (!tasks.length) {
    list.innerHTML = `<div class="feed-empty">No edits to review yet. Each prompt you send becomes a task here, with the files Claude changed under it.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const t of tasks) {
    const unseen = taskUnseen(s, t);
    const el = document.createElement('div');
    el.className = 'task' + (unseen === 0 ? ' done' : '');
    const time = new Date(t.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<div class="thead"><span class="tprompt">${esc(t.prompt)}</span>` +
      (unseen ? `<span class="tbadge">${unseen}</span>` : `<span class="tok">✓</span>`) +
      `<span class="tt">${time}</span></div><div class="tfiles" style="display:none"></div>`;
    const filesEl = el.querySelector('.tfiles');
    el.querySelector('.thead').onclick = () => {
      const open = filesEl.style.display !== 'none';
      filesEl.style.display = open ? 'none' : '';
      if (!open && !filesEl.childElementCount) {
        for (const [np, orig] of t.files) {
          const row = document.createElement('div');
          row.className = 'tfile ' + (s.changed.has(np) && !s.seen.has(np) ? 'unseen' : 'seen');
          row.innerHTML = `<span class="dot"></span><span>${esc(feedLabel({ kind: 'file', value: orig }))}</span>`;
          row.onclick = () => showFile(s, orig);
          filesEl.appendChild(row);
        }
        if (unseen) {
          const mark = document.createElement('button');
          mark.className = 'tmark';
          mark.textContent = 'Mark all reviewed';
          mark.onclick = () => {
            for (const np of t.files.keys()) if (s.changed.has(np)) s.seen.add(np);
            t.reviewed = true;
            s.tree.recomputeMarks();
            renderReview(s);
            reviewChanged(s);
          };
          filesEl.appendChild(mark);
        }
      }
    };
    list.appendChild(el);
  }
}

// ------------------------------------------------------------------ status bar

function renderStatus() {
  const el = $('status');
  if (!active) { el.innerHTML = `<span class="seg">no session</span>`; return; }
  const v = active.status;
  if (!v) {
    el.classList.remove('stale');
    el.innerHTML = `<span class="seg">${esc(basename(active.cwd))}</span><span class="seg" style="color:var(--dim)">waiting for Claude status…</span><span class="spacer"></span><span class="seg">gateway :${gw.port}</span>`;
    return;
  }
  const seg = [];
  const model = v.model?.display_name || v.model?.id || '?';
  seg.push(`<span class="seg">model <b>${esc(model)}</b></span>`);
  const effort = v.effort?.level || v.reasoning_effort || (v.fast_mode ? 'fast' : null);
  if (effort) seg.push(`<span class="seg">effort <b>${esc(String(effort))}</b></span>`);
  const pct = (x) => (x == null ? null : `${Math.round(x)}%`);
  const ctx = pct(v.context_window?.used_percentage);
  if (ctx) seg.push(`<span class="seg${(v.context_window?.used_percentage ?? 0) > 80 ? ' warn' : ''}">context <b>${ctx}</b></span>`);
  const fh = pct(v.rate_limits?.five_hour?.used_percentage);
  if (fh) seg.push(`<span class="seg">5h <b>${fh}</b></span>`);
  const wk = pct(v.rate_limits?.weekly?.used_percentage);
  if (wk) seg.push(`<span class="seg">week <b>${wk}</b></span>`);
  if (v.cost?.total_cost_usd != null) seg.push(`<span class="seg">cost <b>$${v.cost.total_cost_usd.toFixed(2)}</b></span>`);
  seg.push(`<span class="spacer"></span>`);
  if (active.autoCont) seg.push(`<span class="seg warn">⏱ continue ${esc(fmtIn(active.autoCont.at))}</span>`);
  seg.push(`<span class="seg">${esc(basename(active.cwd))}</span>`);
  el.innerHTML = seg.join('');
  el.classList.toggle('stale', Date.now() - active.statusAt > 120000);
}
setInterval(renderStatus, 15000);

// Busy -> attention when a background session's output has been quiet for 3s.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s === active || !s.tabEl) continue;
    if (s.tabEl.classList.contains('busy') && Date.now() - (s.lastOut || 0) > 3000) {
      s.tabEl.classList.remove('busy');
      s.tabEl.classList.add('attn');
      notifyAttn(s);
    }
  }
}, 1000);

// A background session just went quiet (Claude finished or is waiting on you).
// Fire one desktop notification per transition; clicking the tab clears attn,
// so the next quiet period notifies again. Permission is requested lazily.
let notifyOk = false;
isPermissionGranted().then(async (g) => { notifyOk = g || (await requestPermission()) === 'granted'; }).catch(() => {});
function notifyAttn(s) {
  if (!notifyOk || s.notified) return;
  s.notified = true;
  const name = (s.tabEl?.querySelector('.name')?.textContent || basename(s.cwd)).trim();
  try { sendNotification({ title: 'CryDeck', body: `${name} needs you` }); } catch {}
}

/* ---------- command palette: files / search / prompts ---------- */
// Shortcuts use Ctrl+Shift+* on purpose: bare Ctrl+letter belongs to the
// shell's readline (Ctrl+P history, Ctrl+E end-of-line, Ctrl+K kill), and a
// terminal must not steal those. Ctrl+Shift+* is free.
//   Ctrl+Shift+P  find file       -> inserts @path into the active session
//   Ctrl+Shift+F  search in files -> inserts @file
//   Ctrl+Shift+E  open folder in VS Code
//   Ctrl+Shift+K  prompt library  -> types a saved prompt into the session

let paletteOpen = false;

function insertIntoActive(text) {
  if (!active) return;
  invoke('pty_write', { id: active.ptyId, data: text });
  active.term?.focus();
}

function fuzzy(items, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return items.slice(0, 300);
  const scored = [];
  for (const it of items) {
    const s = it.toLowerCase();
    let qi = 0, streak = 0, score = 0;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) { qi++; streak++; score += streak; } else streak = 0;
    }
    if (qi === q.length) {
      if ((s.split(/[\\/]/).pop() || '').includes(q)) score += 50;
      score -= s.length * 0.05;
      scored.push([score, it]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map((x) => x[1]).slice(0, 300);
}

function openPalette({ placeholder, onInput, onPick, initial = [] }) {
  paletteOpen = true;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;z-index:9998;padding-top:12vh';
  const box = document.createElement('div');
  box.style.cssText = 'background:#17171c;border:1px solid #2a2a32;border-radius:8px;width:600px;max-width:92vw;color:#d8d8de;font:13px system-ui;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden';
  const input = document.createElement('input');
  input.placeholder = placeholder;
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:12px 14px;background:#101014;border:none;border-bottom:1px solid #2a2a32;color:#eee;font:13px system-ui;outline:none';
  const list = document.createElement('div');
  list.style.cssText = 'max-height:46vh;overflow:auto';
  box.append(input, list);
  wrap.append(box);
  document.body.append(wrap);
  let rows = [], sel = 0;
  const paint = () => {
    [...list.children].forEach((c, i) => { c.style.background = i === sel ? '#1e2a44' : ''; });
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const render = (items) => {
    rows = items || [];
    sel = 0;
    list.innerHTML = '';
    rows.forEach((it, i) => {
      const r = document.createElement('div');
      r.style.cssText = 'padding:7px 14px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      r.innerHTML = it.html || esc(it.label || it.value || '');
      r.onmouseenter = () => { sel = i; paint(); };
      r.onclick = () => pick(i);
      list.append(r);
    });
    paint();
  };
  const pick = (i) => { const it = rows[i]; close(); if (it) onPick(it); };
  const close = () => { paletteOpen = false; wrap.remove(); window.removeEventListener('keydown', onKey, true); active?.term?.focus(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, rows.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  };
  window.addEventListener('keydown', onKey, true);
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { render(await onInput(input.value)); }, 110);
  });
  render(initial);
  input.focus();
}

async function filesPalette() {
  if (!active) return;
  const all = await invoke('git_ls_files', { root: active.cwd }).catch(() => []);
  if (!all.length) { uiConfirm('No git-tracked files here (not a repo, or empty).', 'OK'); return; }
  const toRows = (arr) => arr.map((f) => ({ value: f, label: f }));
  openPalette({
    placeholder: 'Find file — inserts @path into the session',
    initial: toRows(all.slice(0, 300)),
    onInput: (q) => toRows(fuzzy(all, q)),
    onPick: (it) => insertIntoActive(`@${it.value} `),
  });
}

async function grepPalette() {
  if (!active) return;
  openPalette({
    placeholder: 'Search in files (git grep) — Enter inserts @file',
    onInput: async (q) => {
      if (!q.trim()) return [];
      const hits = await invoke('git_grep', { root: active.cwd, query: q }).catch(() => []);
      return hits.map((h) => ({
        value: h.file,
        html: `<span style="color:#7aa2ff">${esc(h.file)}:${h.line}</span>  <span style="color:#8a8a94">${esc((h.text || '').trim())}</span>`,
      }));
    },
    onPick: (it) => insertIntoActive(`@${it.value} `),
  });
}

/* ---------- prompt library ---------- */
// Lives in ~\.crydeck\prompts.json — outside the app bundle on purpose, so it
// survives updates and any Claude session can append to it (tell Claude "add
// this to my prompt library"). The Rust side watches ~\.crydeck and emits
// cockpit-prompts on change, so external edits show up in the sidebar live.
let promptLib = [];

function normalizePrompts(raw) {
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : Array.isArray(j.prompts) ? j.prompts : [];
    return arr
      .map((p) => typeof p === 'string'
        ? { title: p.length > 60 ? p.slice(0, 60) + '…' : p, desc: '', prompt: p }
        : { title: String(p.title || p.prompt || '').slice(0, 120),
            desc: String(p.desc || p.description || ''),
            prompt: String(p.prompt || '') })
      .filter((p) => p.prompt);
  } catch { return []; }
}

async function loadPromptLib() {
  promptLib = normalizePrompts(await invoke('prompts_load').catch(() => '{"prompts":[]}'));
  // One-time migration of the pre-v0.14 localStorage store.
  const old = localStorage.getItem('cockpit.prompts');
  if (old) {
    for (const t of normalizePrompts(old))
      if (!promptLib.some((p) => p.prompt === t.prompt)) promptLib.push(t);
    localStorage.removeItem('cockpit.prompts');
    if (old !== '[]') await savePromptLib();
  }
  renderPromptPanel();
}

function savePromptLib() {
  const doc = {
    _readme: 'CryDeck prompt library. Items: {title, desc, prompt}. Edit freely — the app reloads this file live. Claude: to save a prompt for the user, append an item here.',
    prompts: promptLib,
  };
  return invoke('prompts_save', { json: JSON.stringify(doc, null, 2) }).catch(() => {});
}

// Type into the active session WITHOUT sending Enter — Sait presses Enter
// himself. Multi-line prompts go as a bracketed paste so newlines don't submit.
function typePrompt(text) {
  if (!active) return;
  insertIntoActive(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
}

function renderPromptPanel() {
  const list = document.querySelector('#prompts .plist');
  if (!list) return;
  list.innerHTML = '';
  if (!promptLib.length) {
    const d = document.createElement('div');
    d.className = 'pempty';
    d.textContent = 'No prompts yet. ＋ saves one, or tell Claude in any session: "add this to my prompt library".';
    list.append(d);
    return;
  }
  promptLib.forEach((p, i) => {
    const r = document.createElement('div');
    r.className = 'prow';
    r.title = p.prompt.length > 400 ? p.prompt.slice(0, 400) + '…' : p.prompt;
    r.innerHTML =
      `<div class="pname"><span class="pacts"><button data-a="edit" title="Edit">✎</button>` +
      `<button data-a="del" title="Delete">✕</button></span>${esc(p.title)}</div>` +
      (p.desc ? `<div class="pdesc">${esc(p.desc)}</div>` : '');
    r.onclick = async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'edit') { editPromptDialog(i); return; }
      if (a === 'del') {
        if (await uiConfirm(`Delete prompt "${p.title}"?`, 'Delete')) {
          promptLib.splice(i, 1);
          await savePromptLib();
          renderPromptPanel();
        }
        return;
      }
      typePrompt(p.prompt);
    };
    list.append(r);
  });
}

// Three-field editor (title / what it does / the prompt itself), used by both
// the ＋ button and ✎ on a row. idx === null means new.
function editPromptDialog(idx = null) {
  const cur = idx !== null ? promptLib[idx] : { title: '', desc: '', prompt: '' };
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
  const card = document.createElement('div');
  card.style.cssText = 'background:#17171c;border:1px solid #2a2a32;border-radius:8px;padding:18px 20px;width:520px;max-width:92vw;color:#d8d8de;font:13px system-ui';
  const fld = 'width:100%;box-sizing:border-box;padding:8px 10px;background:#101014;border:1px solid #2a2a32;border-radius:5px;color:#eee;font:13px system-ui;outline:none;margin:4px 0 10px';
  card.innerHTML =
    `<div style="margin-bottom:6px;font-weight:600">${idx !== null ? 'Edit prompt' : 'New prompt'}</div>` +
    `<div style="color:#8a8a94">Title</div><input id="pe-title" style="${fld}" />` +
    `<div style="color:#8a8a94">What it does (shown on hover)</div><input id="pe-desc" style="${fld}" />` +
    `<div style="color:#8a8a94">Prompt</div><textarea id="pe-text" rows="6" style="${fld};resize:vertical;font:12px 'Cascadia Mono',Consolas,monospace"></textarea>` +
    `<div style="display:flex;gap:8px;justify-content:flex-end">` +
    `<button id="pe-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid #3a3a44;background:#22222a;color:#eee;cursor:pointer;font:12.5px system-ui">Cancel</button>` +
    `<button id="pe-save" style="padding:6px 14px;border-radius:6px;border:1px solid #2a5;background:#264d2e;color:#eee;cursor:pointer;font:12.5px system-ui">Save</button></div>`;
  wrap.append(card);
  document.body.append(wrap);
  const $ = (id) => card.querySelector(id);
  $('#pe-title').value = cur.title;
  $('#pe-desc').value = cur.desc;
  $('#pe-text').value = cur.prompt;
  const close = () => wrap.remove();
  $('#pe-cancel').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $('#pe-save').onclick = async () => {
    const prompt = $('#pe-text').value.trim();
    if (!prompt) return;
    const item = {
      title: $('#pe-title').value.trim() || (prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt),
      desc: $('#pe-desc').value.trim(),
      prompt,
    };
    if (idx !== null) promptLib[idx] = item; else promptLib.push(item);
    close();
    await savePromptLib();
    renderPromptPanel();
  };
  $('#pe-title').focus();
}

function promptsPalette() {
  if (!active) return;
  const items = (q = '') => {
    const ql = q.toLowerCase();
    const rows = promptLib
      .filter((p) => !ql || (p.title + ' ' + p.desc + ' ' + p.prompt).toLowerCase().includes(ql))
      .map((p) => ({
        value: p.prompt,
        html: esc(p.title) + (p.desc ? `  <span style="color:#8a8a94">${esc(p.desc)}</span>` : ''),
      }));
    rows.push({ add: true, html: '<span style="color:#7aa2ff">＋ Save a new prompt…</span>' });
    return rows;
  };
  openPalette({
    placeholder: 'Prompts — Enter types the prompt into the session (you press Enter to send)',
    initial: items(),
    onInput: (q) => items(q),
    onPick: (it) => { if (it.add) editPromptDialog(); else typePrompt(it.value); },
  });
}

// Sidebar panel wiring: add, collapse, live reload on external file edits.
{
  const panel = document.getElementById('prompts');
  const fold = document.getElementById('pr-fold');
  const setFold = (closed) => {
    panel.classList.toggle('closed', closed);
    fold.textContent = closed ? '▸' : '▾';
    localStorage.setItem('cockpit.promptsFold', closed ? '1' : '');
  };
  document.getElementById('pr-add').onclick = (e) => { e.stopPropagation(); editPromptDialog(); };
  fold.onclick = (e) => { e.stopPropagation(); setFold(!panel.classList.contains('closed')); };
  panel.querySelector('.phdr').onclick = () => setFold(!panel.classList.contains('closed'));
  setFold(localStorage.getItem('cockpit.promptsFold') === '1');
  listen('cockpit-prompts', () => loadPromptLib());
  loadPromptLib();
}

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (!'pfek'.includes(k)) return;
  e.preventDefault();
  e.stopPropagation();
  if (paletteOpen) return;
  if (k === 'p') filesPalette();
  else if (k === 'f') grepPalette();
  else if (k === 'e') { if (active) invoke('open_in_editor', { root: active.cwd }).catch(() => {}); }
  else if (k === 'k') promptsPalette();
}, true);

/* ---------- extra terminals under the preview ---------- */

const MAX_SHELLS = 3;

async function spawnShell(s) {
  if (s.shells.length >= MAX_SHELLS) return;
  const term = new Terminal({
    scrollback: 5000,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 12.5,
    cursorBlink: true,
    allowProposedApi: true,
    theme: { background: '#0d0d10', foreground: '#d8d8de' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new UnicodeGraphemesAddon()); } catch {}
  const box = document.createElement('div');
  box.className = 'termbox';
  $('sh-body').appendChild(box);
  term.open(box);

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const onOutput = new Channel();
  onOutput.onmessage = (msg) => {
    const bytes = msg instanceof ArrayBuffer ? new Uint8Array(msg)
      : (ArrayBuffer.isView(msg) ? new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
      : new Uint8Array(msg));
    term.write(decoder.decode(bytes, { stream: true }));
  };
  const args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${gw.init_ps1}'`];
  let ptyId;
  const opts = (cmd) => ({ cmd, args, cwd: s.cwd, cols: term.cols || 90, rows: term.rows || 14, onOutput });
  try { ptyId = await invoke('pty_spawn', opts('pwsh.exe')); }
  catch { ptyId = await invoke('pty_spawn', opts('powershell.exe')); }
  term.onData((d) => { const g = guardData(d); if (g !== null) invoke('pty_write', { id: ptyId, data: g }); });
  wireClipboard(term, box);

  const sh = { ptyId, term, fit, box, lastSize: '' };
  s.shells.push(sh);
  s.shellIdx = s.shells.length - 1;
  renderShells(s);
}

function fitShell(s) {
  const sh = s.shells[s.shellIdx];
  if (!sh) return;
  sh.fit.fit();
  const { cols, rows } = sh.term;
  if (cols < 2 || rows < 2) return;
  const key = `${cols}x${rows}`;
  if (key !== sh.lastSize) {
    sh.lastSize = key;
    invoke('pty_resize', { id: sh.ptyId, cols, rows });
  }
}

function renderShells(s) {
  const strip = $('pv-shells');
  strip.classList.toggle('open', s.shellsOpen && s.shells.length > 0);
  const tabs = $('sh-tabs');
  tabs.innerHTML = '';
  s.shells.forEach((sh, i) => {
    const t = document.createElement('span');
    t.className = 'stab' + (i === s.shellIdx ? ' on' : '');
    t.textContent = `term ${i + 1}`;
    t.onclick = () => { s.shellIdx = i; renderShells(s); };
    t.oncontextmenu = (ev) => {
      ev.preventDefault();
      contextMenu(ev, [['Close terminal', () => {
        invoke('pty_kill', { id: sh.ptyId }).catch(() => {});
        sh.term.dispose(); sh.box.remove();
        s.shells.splice(i, 1);
        if (s.shellIdx >= s.shells.length) s.shellIdx = s.shells.length - 1;
        if (!s.shells.length) s.shellsOpen = false;
        renderShells(s);
      }]]);
    };
    tabs.appendChild(t);
  });
  for (let i = 0; i < s.shells.length; i++)
    s.shells[i].box.classList.toggle('active', i === s.shellIdx && s.shellsOpen);
  // Other sessions' shell boxes stay detached from view.
  for (const o of sessions.values())
    if (o !== s) for (const sh of o.shells) sh.box.classList.remove('active');
  if (s.shellsOpen && s.shells.length) requestAnimationFrame(() => { fitShell(s); s.shells[s.shellIdx]?.term.focus(); });
}

$('shellToggle').onclick = async () => {
  if (!active) return;
  active.shellsOpen = !active.shellsOpen;
  if (active.shellsOpen && !active.shells.length) await spawnShell(active);
  renderShells(active);
};
$('sh-add').onclick = () => active && spawnShell(active);
$('sh-close').onclick = () => { if (active) { active.shellsOpen = false; renderShells(active); } };
new ResizeObserver(() => active && active.shellsOpen && fitShell(active)).observe($('sh-body'));

// Minimal floating context menu; dies on any click or Escape.
function contextMenu(ev, items) {
  document.getElementById('ctxmenu')?.remove();
  const m = document.createElement('div');
  m.id = 'ctxmenu';
  m.style.cssText = `position:fixed;left:${ev.clientX}px;top:${ev.clientY}px;z-index:99;` +
    'background:#1c1c24;border:1px solid #35353f;border-radius:6px;padding:3px;min-width:150px;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.5)';
  for (const [label, fn] of items) {
    const it = document.createElement('div');
    it.textContent = label;
    it.style.cssText = 'padding:5px 12px;border-radius:4px;cursor:pointer';
    it.onmouseenter = () => (it.style.background = '#24304a');
    it.onmouseleave = () => (it.style.background = '');
    it.onclick = () => { m.remove(); fn(); };
    m.appendChild(it);
  }
  document.body.appendChild(m);
  const kill = () => { m.remove(); window.removeEventListener('pointerdown', onDown, true); };
  const onDown = (e) => { if (!m.contains(e.target)) kill(); };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { kill(); window.removeEventListener('keydown', onKey); }
  });
}

function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + 'MB';
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

// ------------------------------------------------------------------ splitters

function splitter(el, cssVar, sign) {
  el.addEventListener('pointerdown', (down) => {
    el.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar));
    const move = (ev) => {
      const w = Math.max(140, Math.min(window.innerWidth * 0.45, startW + sign * (ev.clientX - startX)));
      document.documentElement.style.setProperty(cssVar, `${w}px`);
      scheduleResize();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      localStorage.setItem(`cockpit${cssVar}`, getComputedStyle(document.documentElement).getPropertyValue(cssVar));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
splitter($('s1'), '--tree-w', 1);
splitter($('s2'), '--preview-w', -1);
for (const vn of ['--tree-w', '--preview-w']) {
  const saved = localStorage.getItem(`cockpit${vn}`);
  if (saved) document.documentElement.style.setProperty(vn, saved);
}

// The WebView2 default context menu and F5/Ctrl+R reload the page, which tears
// down every terminal. Kill both paths, but leave the keys alone while focus
// is inside a terminal (Ctrl+R is history search in pwsh and Claude).
window.addEventListener('keydown', (e) => {
  const inTerm = e.target.closest?.('.termbox');
  if (inTerm) return;
  if (e.key === 'F5' || (e.ctrlKey && e.code === 'KeyR')) e.preventDefault();
}, true);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------ boot

// Closing the window kills every session's process tree (that is the leak
// protection doing its job) — so make it a decision, not an accident. The
// conversations themselves survive on disk and are resumed by session id.
// window.confirm() is a no-op in Tauri's webview (always falsy), which made
// the X button dead whenever sessions were live — hence the in-page dialog.
function uiConfirm(msg, okLabel = 'Close') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
    const card = document.createElement('div');
    card.style.cssText = 'background:#17171c;border:1px solid #2a2a32;border-radius:8px;padding:18px 20px;max-width:380px;color:#d8d8de;font:13px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    const p = document.createElement('div');
    p.textContent = msg;
    p.style.cssText = 'margin-bottom:14px;line-height:1.5;white-space:pre-line';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const mkBtn = (label, val, accent) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `padding:6px 14px;border-radius:6px;border:1px solid ${accent ? '#c0392b' : '#3a3a44'};background:${accent ? '#8e2b20' : '#22222a'};color:#eee;cursor:pointer;font:12.5px system-ui`;
      b.onclick = () => { wrap.remove(); resolve(val); };
      return b;
    };
    row.append(mkBtn('Cancel', false, false), mkBtn(okLabel, true, true));
    card.append(p, row);
    wrap.append(card);
    wrap.onclick = (e) => { if (e.target === wrap) { wrap.remove(); resolve(false); } };
    document.body.append(wrap);
  });
}
getCurrentWindow().onCloseRequested(async (ev) => {
  if (!sessions.size) return;
  ev.preventDefault();
  if (await uiConfirm(`Close CryDeck? ${sessions.size} session(s) will stop.\nConversations resume on next launch.`))
    getCurrentWindow().destroy();
});

async function boot() {
  // If the WebView reloaded anyway (crash recovery), the old shells are
  // orphans; reap them before spawning the restored set.
  await invoke('pty_kill_all').catch(() => {});
  gw = await invoke('gateway_info');
  trace(`gateway on :${gw.port}`);

  const nt = document.createElement('button');
  nt.id = 'newtab';
  nt.textContent = '+ session';
  nt.onclick = pickAndOpen;
  $('tabs').appendChild(nt);

  const mb = document.createElement('button');
  mb.id = 'modelbtn';
  mb.title = 'Model and effort for Claude';
  mb.textContent = modelBtnLabel();
  mb.onclick = () => ($('modelmenu') ? $('modelmenu').remove() : showModelMenu(mb));
  $('tabs').appendChild(mb);

  const ab = document.createElement('button');
  ab.id = 'about-btn';
  ab.textContent = 'ⓘ';
  ab.title = 'About CryDeck';
  ab.style.cssText = 'background:none;border:none;color:#6a6a74;cursor:pointer;font-size:14px;padding:0 10px;align-self:center';
  ab.onclick = showAbout;
  $('tabs').appendChild(ab);

  let restored = [];
  try { restored = JSON.parse(localStorage.getItem('cockpit.tabs') || '[]'); } catch {}
  for (const t of restored.slice(0, MAX_SESSIONS)) {
    // Builds before v0.18.1 saved bare folder strings, with no session id.
    const cwd = typeof t === 'string' ? t : t?.cwd;
    const sid = typeof t === 'string' ? null : t?.sid;
    if (!cwd) continue;
    try { await newSession(cwd, { resume: true, sid }); } catch (e) { trace(`restore ${cwd} failed: ${e}`); }
  }
  const cli = await invoke('boot_folder');
  if (cli && ![...sessions.values()].some((s) => norm(s.cwd) === norm(cli))) {
    try { await newSession(cli, { resume: true }); } catch (e) { trace(`cli open failed: ${e}`); }
  }
  if (!sessions.size) renderEmpty();
  trace('boot complete');
  setTimeout(maybeUpdate, 4000);

  // First-run: if prerequisites are missing, offer to install them inside a
  // regular session tab — the tab runs winget/installer, then flows straight
  // into claude's own first-launch login. All installed → nothing to see here.
  const env = await invoke('env_check').catch(() => null);
  trace(`env_check: git=${env ? env.git : '?'} claude=${env ? env.claude : '?'} pwsh=${env ? env.pwsh : '?'}`);
  if (env && (!env.git || !env.claude || !env.pwsh)) {
    const missing = [!env.pwsh && 'PowerShell 7', !env.git && 'Git', !env.claude && 'Claude Code'].filter(Boolean);
    const ok = await uiConfirm(
      `Welcome to CryDeck! One-time setup: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed yet.\n\n` +
      `Install now? It runs right here in a terminal tab and finishes by starting Claude, which asks you to log in ` +
      `(you need a Claude account, Pro or Max plan). Approve the Windows permission popup if one appears.`,
      'Install');
    trace(`setup prompt: ${ok ? 'accepted' : 'declined'}`);
    if (ok) {
      const dir = await invoke('projects_dir').catch(() => 'C:\\');
      // Always open a dedicated setup tab. The old code skipped setup whenever
      // a session already sat at the Projects folder — but a restored tab lands
      // there on every launch, so clicking Install silently did nothing (the
      // "kaldı öyle" bug). A second Projects tab is harmless, and a fresh setup
      // tab is a clean shell that installs first instead of one already trying
      // (and failing) to launch a not-yet-installed claude.
      try {
        const ss = await newSession(dir, { setup: { git: !env.git, claude: !env.claude } });
        trace(`setup session started: ${ss ? ss.ptyId : 'null'} at ${dir}`);
      } catch (e) { trace(`setup session failed: ${e}`); }
    }
  }

  // Start with Windows, on by default. Only force it once (first ever launch),
  // so a user who later turns it off in the About card stays off across
  // restarts instead of having it re-enabled every boot.
  if (!localStorage.getItem('cockpit.autostart.init')) {
    try { await autostartEnable(); trace('autostart enabled (default)'); }
    catch (e) { trace(`autostart enable failed: ${e}`); }
    localStorage.setItem('cockpit.autostart.init', '1');
  }
}
boot();

// Everything CryDeck can do, in plain language, so a new user never has to
// stumble onto a feature. Rendered in the About card's Features panel. Keep it
// in step with the changelog when a user-facing feature lands.
const FEATURES_MD = `
Short list of everything. For detail see the [GitHub README](https://github.com/crymetr/crydeck#readme).

**Sessions & setup**
- Each tab is a Claude Code session in a folder; close and reopen and conversations resume.
- Fresh PC: first run installs PowerShell 7, Git, and Claude Code, then logs you in.
- Up to 10 sessions, plus up to 3 extra plain terminals under each.
- Starts with Windows (toggle above) and auto-updates itself.
- New version while you work: an amber ↑ pill appears in the tab bar (checked every 10 minutes, no popup). Click it when you are ready — installing restarts CryDeck.

**Know what each session is doing**
- Tab dot: blue working, amber done, red waiting on you, none idle.
- Desktop notification when a background session finishes or needs you.
- Status bar: model, effort, context %, rate limits, session cost.
- Model & effort picker (top right): switches the active session right away and every new one after it.
- Auto-continue after a rate limit: right-click a tab to schedule it.

**The file tree & preview**
- Live tree; Claude's edits glow amber, turn green once seen, blue dot = uncommitted git change.
- File view: code, rendered markdown, images, with a Content|Diff switch.
- HTML and PDF files render automatically; the App pane runs your dev server's localhost.
- Feed: everything Claude produced. Review: edits grouped under the prompt that caused them.
- Point at the running app: click an element (🎯) or draw annotations (✏️) and send them to Claude.

**Remote & orchestration**
- Remote Control: steer any session from your phone or the web.
- \`crydeck\` CLI on every session: \`spawn <folder> [prompt]\`, \`list\`, \`read <id>\`, \`send <id> <text>\` — so a session can open and drive others (and you can spawn new work from your phone).

**Prompt library**
- Bottom-left panel: click a title to type that prompt into the active session — you press Enter to send. Hover shows what it does.
- Lives in \`~\\.crydeck\\prompts.json\` and reloads live: tell Claude in any session "add this to my prompt library" and it appears without an app update.
- ＋ adds one by hand, ✎/✕ on hover edit and delete, Ctrl+Shift+K searches the same library.

**Shortcuts & OS**
- Ctrl+Shift+P find file · Ctrl+Shift+F search in files · Ctrl+Shift+E open in VS Code · Ctrl+Shift+K prompts.
- Double-click opens a file in its default app; right-click a folder to open it as a session.
- Copy with Ctrl+C on a selection, paste with Ctrl+V or right-click.
- Paste is clipboard-aware: a copied screenshot or Explorer-copied file pastes as a path Claude can read.
- Code pane (next to Review/Feed): every code block Claude replies with, newest first, one-click copy.
`;

// Minimal about card: version, links, changelog. Links open in the default
// browser via os_open (cmd start) — no opener plugin needed.
async function showAbout() {
  const ver = await getVersion().catch(() => '?');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
  const link = (label, url) =>
    `<a href="#" data-url="${url}" style="color:#7aa2ff;text-decoration:none">${label}</a>`;
  const card = document.createElement('div');
  card.style.cssText = 'background:#17171c;border:1px solid #2a2a32;border-radius:8px;padding:18px 22px;width:480px;max-width:94vw;color:#d8d8de;font:12.5px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.5)';
  const hi = (t) => `<li style="margin:2px 0">${t}</li>`;
  card.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
      <b style="font-size:14px">CryDeck</b><span style="color:#8a8a94">v${esc(ver)}</span>
      <span style="flex:1"></span>
      <button id="ab-feat" style="background:#22222a;border:1px solid #3a3a44;border-radius:5px;color:#ccc;padding:3px 9px;cursor:pointer;font:11.5px system-ui">All features</button>
      <button id="ab-log" style="background:#22222a;border:1px solid #3a3a44;border-radius:5px;color:#ccc;padding:3px 9px;cursor:pointer;font:11.5px system-ui">Changelog</button>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      ${link('GitHub &amp; docs', 'https://github.com/crymetr/crydeck#readme')}
      ${link('cryme.tr', 'https://cryme.tr')}
      ${link('☕ Buy me a coffee', 'https://cryme.tr/support')}
    </div>
    <div style="margin-top:14px;border-top:1px solid #2a2a32;padding-top:12px">
      <b style="color:#aab;font-size:12px">What you get</b>
      <ul style="margin:6px 0 0;padding-left:18px;line-height:1.55;color:#c7c7cf">
        ${hi('A tab is a Claude Code session; close and reopen and your conversations come back.')}
        ${hi('Fresh PC? First run installs PowerShell 7, Git, and Claude Code for you.')}
        ${hi('The tab dot shows each session at a glance: blue working, amber done, red waiting on you.')}
        ${hi('Live file tree + a preview pane that runs your app and renders HTML.')}
        ${hi('Steer sessions from your phone, and open new ones with the built-in <code>crydeck</code> command.')}
        ${hi('Hit a rate limit? Right-click a tab to auto-continue right after it resets.')}
      </ul>
      <div style="margin-top:8px;font-size:11.5px;color:#8a8a94">Full list below, or the ${link('GitHub README', 'https://github.com/crymetr/crydeck#readme')} for detail.</div>
    </div>
    <label id="ab-autostart-row" style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer">
      <input type="checkbox" id="ab-autostart" style="cursor:pointer">
      <span>Start CryDeck when Windows starts</span>
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer">
      <input type="checkbox" id="ab-autorender" style="cursor:pointer">
      <span>Render HTML and PDF files automatically when selected</span>
    </label>
    <div style="margin-top:12px;font-size:11.5px;color:#8a8a94;line-height:1.7">
      <b style="color:#aab">Shortcuts</b><br>
      Ctrl+Shift+P find file &nbsp;·&nbsp; Ctrl+Shift+F search in files<br>
      Ctrl+Shift+E open in VS Code &nbsp;·&nbsp; Ctrl+Shift+K prompts
    </div>
    <div id="ab-body" style="display:none;margin-top:12px;max-height:300px;overflow:auto;border-top:1px solid #2a2a32;padding-top:10px;font-size:12px;line-height:1.5"></div>`;
  card.querySelectorAll('a[data-url]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); invoke('os_open', { path: a.dataset.url }); };
  });
  const asBox = card.querySelector('#ab-autostart');
  autostartIsEnabled().then((on) => { asBox.checked = !!on; }).catch(() => {});
  asBox.onchange = async () => {
    try { asBox.checked ? await autostartEnable() : await autostartDisable(); }
    catch (e) { trace(`autostart toggle failed: ${e}`); asBox.checked = !asBox.checked; }
  };
  const arBox = card.querySelector('#ab-autorender');
  arBox.checked = autoRenderHtml;
  arBox.onchange = () => {
    autoRenderHtml = arBox.checked;
    localStorage.setItem('cockpit.autorender', autoRenderHtml ? '1' : '0');
  };
  // Two panels share the one body area: Features (what you can do) and
  // Changelog (what changed). Clicking a button shows its panel, or hides it if
  // already showing. Features exists so nothing has to be discovered by accident.
  const body = card.querySelector('#ab-body');
  let shown = null;
  const togglePanel = (which, html) => {
    if (shown === which) { body.style.display = 'none'; shown = null; return; }
    body.innerHTML = html;
    // Markdown links in the panel must open in the real browser, not navigate
    // the app window.
    for (const a of body.querySelectorAll('a[href]')) {
      const url = a.getAttribute('href');
      a.onclick = (e) => { e.preventDefault(); invoke('os_open', { path: url }); };
    }
    body.style.display = 'block';
    body.scrollTop = 0;
    shown = which;
  };
  card.querySelector('#ab-feat').onclick = () => togglePanel('feat', marked.parse(FEATURES_MD));
  card.querySelector('#ab-log').onclick = () => togglePanel('log', marked.parse(changelogRaw));
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  window.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { wrap.remove(); window.removeEventListener('keydown', onKey); }
  });
  wrap.append(card);
  document.body.append(wrap);
}

// Auto-update: check GitHub Releases (latest.json) after boot, then every 10
// minutes while the app runs and whenever the window regains focus, so a fresh
// release shows up without closing and reopening to find it. Dev builds and
// offline starts fail the check silently — that's fine.
//
// A find never interrupts: installing relaunches the app and takes every
// session down with it, so the update waits behind a pill in the tab bar until
// it is a good moment to click it. Polling stops once one is found.
const UPDATE_POLL_MS = 10 * 60 * 1000;
const UPDATE_FOCUS_MIN_MS = 5 * 60 * 1000;
let updateFound = null;
let lastUpdateCheck = 0;

async function maybeUpdate() {
  if (updateFound) return;
  lastUpdateCheck = Date.now();
  let up;
  try { up = await checkUpdate(); } catch (e) { trace(`update check: ${e}`); return; }
  if (!up) return;
  updateFound = up;
  trace(`update ${up.version} available`);
  showUpdateBtn(up);
  if (notifyOk) {
    try { sendNotification({ title: 'CryDeck', body: `v${up.version} is ready to install` }); } catch {}
  }
}

setInterval(maybeUpdate, UPDATE_POLL_MS);
getCurrentWindow()
  .onFocusChanged(({ payload: focused }) => {
    if (focused && Date.now() - lastUpdateCheck >= UPDATE_FOCUS_MIN_MS) maybeUpdate();
  })
  .catch(() => {});

function showUpdateBtn(up) {
  if ($('updatebtn')) return;
  const b = document.createElement('button');
  b.id = 'updatebtn';
  b.textContent = `↑ v${up.version}`;
  b.title = `CryDeck ${up.version} is ready (you have ${up.currentVersion}). Installing closes your sessions and restarts.`;
  b.onclick = () => installUpdate(up);
  $('tabs').appendChild(b);
}

async function installUpdate(up) {
  if (!(await uiConfirm(`Install CryDeck ${up.version} now?\nSessions close and CryDeck restarts.`, 'Update')))
    return;
  try {
    await up.downloadAndInstall();
    await relaunch();
  } catch (e) {
    trace(`update install: ${e}`);
    uiConfirm(`Update failed: ${e}`, 'OK');
  }
}
