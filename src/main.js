// Cockpit frontend. One module on purpose: the app is a coordinator between
// four panes and a PTY, and splitting it into files would manufacture
// indirection, not structure. Design v2 in PLAN.md is the spec.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { marked } from 'marked';
import '@xterm/xterm/css/xterm.css';

const MAX_SESSIONS = 6;
const trace = (m) => { try { invoke('bench_report', { line: `[ui] ${m}` }); } catch {} };
window.addEventListener('error', (e) => trace(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) =>
  trace(`REJECT ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

const $ = (id) => document.getElementById(id);
const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let gw = null;                 // { port, init_ps1, settings_json }
const sessions = new Map();    // ptyId -> session
let active = null;             // session or null

// ------------------------------------------------------------------ sessions

async function newSession(cwd) {
  if (sessions.size >= MAX_SESSIONS) {
    alert(`Session cap is ${MAX_SESSIONS}. Close a tab first.`);
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
  // to blank the terminal until the next repaint. Recreate after loss instead.
  const attachWebgl = () => {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { webgl.dispose(); setTimeout(attachWebgl, 500); });
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
    pvMode: 'feed', pvFile: null, appUrl: '', iframe: null,
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

  s.term.onData((d) => invoke('pty_write', { id: s.ptyId, data: d }));
  s.term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
      navigator.clipboard.readText().then((t) => t && invoke('pty_write', { id: s.ptyId, data: t }));
      return false;
    }
    if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
      const sel = s.term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    return true;
  });

  // A tab IS a Claude session: launch it once the shell has settled, with
  // Remote Control on so the phone can pick any session up.
  setTimeout(() => {
    if (sessions.has(s.ptyId))
      invoke('pty_write', { id: s.ptyId, data: `claude --remote-control "${basename(cwd)}"\r` });
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
  invoke('pty_kill', { id: s.ptyId }).catch(() => {});
  invoke('fs_unwatch', { tab: s.ptyId }).catch(() => {});
  sessions.delete(s.ptyId);
  s.term.dispose();
  s.box.remove();
  s.tabEl.remove();
  s.tree.el.remove();
  if (s.iframe) s.iframe.remove();
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
    o.tree.el.style.display = o === s ? '' : 'none';
    if (o.iframe) o.iframe.style.display = 'none';
  }
  $('empty')?.remove();
  if (s.treeDirty) { s.treeDirty = false; s.tree.refresh(); }
  requestAnimationFrame(() => { fitActive(); s.term.focus(); });
  setPvMode(s.pvMode, true);
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
  el.innerHTML = `<span class="name">${esc(basename(s.cwd))}</span><button class="close" title="Close session">×</button>`;
  el.title = s.cwd;
  el.onclick = () => activate(s);
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

function persistTabs() {
  localStorage.setItem('cockpit.tabs', JSON.stringify([...sessions.values()].map((s) => s.cwd)));
}

function renderEmpty() {
  if ($('empty')) return;
  const d = document.createElement('div');
  d.id = 'empty';
  d.innerHTML = `<div>No sessions.</div><button>Open a folder</button>`;
  d.querySelector('button').onclick = pickAndOpen;
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
  trace(`fs change in session ${s.ptyId}`);
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
  if (mode === 'file' && active.pvFile) renderFile(active);
  if (mode === 'app') renderApp(active);
  if (mode === 'feed') renderFeed(active);
}
for (const b of document.querySelectorAll('#pv-modes button'))
  b.onclick = () => setPvMode(b.dataset.mode);

function showFile(s, path) {
  s.pvFile = path;
  const np = norm(path);
  if (s.changed.has(np) && !s.seen.has(np)) {
    s.seen.add(np);
    s.tree.recomputeMarks();
  }
  if (s === active) { setPvMode('file', true); }
}

async function renderFile(s) {
  const pane = $('pv-file');
  pane.innerHTML = `<div class="path">${esc(s.pvFile)}</div><div class="content"><div class="note">loading…</div></div>`;
  let c;
  try { c = await invoke('fs_read', { path: s.pvFile }); }
  catch (e) { pane.querySelector('.content').innerHTML = `<div class="note">${esc(String(e))}</div>`; return; }
  if (s !== active || s.pvMode !== 'file') return;
  const content = pane.querySelector('.content');
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

function renderApp(s) {
  $('pv-url').value = s.appUrl;
  const ph = document.querySelector('#pv-app .placeholder');
  for (const o of sessions.values())
    if (o.iframe) o.iframe.style.display = 'none';
  if (s.appUrl && s.iframe) {
    ph.style.display = 'none';
    s.iframe.style.display = '';
  } else {
    ph.style.display = '';
  }
}

function loadApp(s, url) {
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  s.appUrl = url;
  if (!s.iframe) {
    // One live iframe per session, so switching tabs never reloads your app
    // state. That is the "own preview state" requirement, literally.
    s.iframe = document.createElement('iframe');
    if (s !== active) s.iframe.style.display = 'none';
    $('pv-app').appendChild(s.iframe);
  }
  s.iframe.src = url;
  if (s === active) setPvMode('app', true);
}
$('pv-go').onclick = () => active && $('pv-url').value.trim() && loadApp(active, $('pv-url').value.trim());
$('pv-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pv-go').click(); });
$('pv-reload').onclick = () => { if (active?.iframe) active.iframe.src = active.iframe.src; };
$('pv-ext').onclick = () => active?.appUrl && invoke('os_open', { path: active.appUrl });

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
    if (!s.appUrl) loadApp(s, u);
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
  if (best && sid) best.claudeSid = sid;
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
});

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
  seg.push(`<span class="seg">${esc(basename(active.cwd))}</span>`);
  el.innerHTML = seg.join('');
  el.classList.toggle('stale', Date.now() - active.statusAt > 120000);
}
setInterval(renderStatus, 15000);

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

  let restored = [];
  try { restored = JSON.parse(localStorage.getItem('cockpit.tabs') || '[]'); } catch {}
  for (const cwd of restored.slice(0, MAX_SESSIONS)) {
    try { await newSession(cwd); } catch (e) { trace(`restore ${cwd} failed: ${e}`); }
  }
  const cli = await invoke('boot_folder');
  if (cli && ![...sessions.values()].some((s) => norm(s.cwd) === norm(cli))) {
    try { await newSession(cli); } catch (e) { trace(`cli open failed: ${e}`); }
  }
  if (!sessions.size) renderEmpty();
  trace('boot complete');
}
boot();
