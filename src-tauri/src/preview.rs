// Interactive preview: one Tauri child webview per session, positioned over
// the App pane's rect. A child webview (unlike the old iframe) lets us inject
// a script into every page it loads — that script implements element picking
// and annotation drawing, and reports back through the hook gateway (fetch to
// 127.0.0.1), which sidesteps Tauri IPC entirely for remote origins.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::webview::WebviewBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

pub struct PreviewState {
    // session id -> webview label
    views: Mutex<HashMap<u32, String>>,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            views: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(serde::Deserialize, Clone, Copy)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// The script injected into every page the preview loads. Baked per-session
/// with the gateway endpoint so reports carry the right tab identity.
fn init_script(tab: u32, port: u16, token: &str) -> String {
    format!(
        r#"(() => {{
if (window.__crydeck) return; window.__crydeck = true;
const POST = (route, data) => {{
  try {{ fetch(`http://127.0.0.1:{port}/${{route}}?token={token}`, {{
    method: 'POST', body: JSON.stringify(Object.assign({{ tab: {tab}, url: location.href }}, data))
  }}).catch(() => {{}}); }} catch (e) {{}}
}};

/* ---------- element picker ---------- */
let pickOn = false, hoverEl = null;
const outline = document.createElement('div');
outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4d9fff;background:rgba(77,159,255,.12);border-radius:2px;display:none;transition:all .05s';
const cssPath = (el) => {{
  const bits = [];
  while (el && el.nodeType === 1 && bits.length < 5) {{
    let b = el.tagName.toLowerCase();
    if (el.id) {{ bits.unshift(b + '#' + el.id); break; }}
    const cls = [...el.classList].slice(0, 2).join('.');
    if (cls) b += '.' + cls;
    bits.unshift(b);
    el = el.parentElement;
  }}
  return bits.join(' > ');
}};
const onMove = (e) => {{
  hoverEl = document.elementFromPoint(e.clientX, e.clientY);
  if (!hoverEl || hoverEl === outline) return;
  const r = hoverEl.getBoundingClientRect();
  outline.style.display = 'block';
  Object.assign(outline.style, {{ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }});
}};
const onClick = (e) => {{
  if (!hoverEl) return;
  e.preventDefault(); e.stopPropagation();
  const r = hoverEl.getBoundingClientRect();
  POST('select', {{
    selector: cssPath(hoverEl),
    text: (hoverEl.innerText || hoverEl.value || '').trim().slice(0, 120),
    rect: {{ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }},
    html: hoverEl.outerHTML.slice(0, 400)
  }});
  window.__crydeck_pick(false);
}};
window.__crydeck_pick = (on) => {{
  pickOn = on;
  if (on) {{
    document.documentElement.appendChild(outline);
    addEventListener('mousemove', onMove, true);
    addEventListener('click', onClick, true);
    document.documentElement.style.cursor = 'crosshair';
  }} else {{
    outline.remove(); outline.style.display = 'none';
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    document.documentElement.style.cursor = '';
  }}
}};

/* ---------- annotations ---------- */
let annOn = false, annRects = [], drawing = null, canvas = null, ctx = null;
const redraw = () => {{
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#e2b93d'; ctx.lineWidth = 3; ctx.font = '14px sans-serif'; ctx.fillStyle = '#e2b93d';
  annRects.forEach((r, i) => {{
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillText(String(i + 1), r.x + 4, r.y + 16);
  }});
  if (drawing) ctx.strokeRect(drawing.x, drawing.y, drawing.w, drawing.h);
}};
const aDown = (e) => {{ drawing = {{ x: e.clientX, y: e.clientY, w: 0, h: 0 }}; }};
const aMove = (e) => {{ if (drawing) {{ drawing.w = e.clientX - drawing.x; drawing.h = e.clientY - drawing.y; redraw(); }} }};
const aUp = () => {{
  if (drawing && Math.abs(drawing.w) > 8 && Math.abs(drawing.h) > 8) {{
    const r = {{ x: Math.min(drawing.x, drawing.x + drawing.w), y: Math.min(drawing.y, drawing.y + drawing.h),
               w: Math.abs(drawing.w), h: Math.abs(drawing.h) }};
    const el = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
    r.near = el ? cssPath(el) : '';
    annRects.push(r);
  }}
  drawing = null; redraw();
}};
window.__crydeck_annotate = (on) => {{
  annOn = on;
  if (on && !canvas) {{
    canvas = document.createElement('canvas');
    canvas.width = innerWidth; canvas.height = innerHeight;
    canvas.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair';
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');
    canvas.addEventListener('mousedown', aDown);
    canvas.addEventListener('mousemove', aMove);
    canvas.addEventListener('mouseup', aUp);
  }} else if (!on && canvas) {{
    canvas.remove(); canvas = null; ctx = null; annRects = [];
  }}
}};
window.__crydeck_annotations = () => {{
  POST('annotate', {{ rects: annRects }});
}};
addEventListener('keydown', (e) => {{
  if (e.key === 'Escape') {{ if (pickOn) window.__crydeck_pick(false); if (annOn) window.__crydeck_annotate(false); POST('pickoff', {{}}); }}
}});
}})();"#
    )
}

fn label_for(tab: u32) -> String {
    format!("preview-{tab}")
}

#[tauri::command]
pub fn preview_open(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    gw: tauri::State<'_, crate::hooks::Gateway>,
    tab: u32,
    url: String,
    rect: Rect,
) -> Result<(), String> {
    let mut views = state.views.lock().unwrap();
    if let Some(label) = views.get(&tab) {
        if let Some(wv) = window.get_webview(label) {
            let u = url.parse().map_err(|e| format!("bad url: {e}"))?;
            wv.navigate(u).map_err(|e| e.to_string())?;
            return Ok(());
        }
        views.remove(&tab);
    }
    let label = label_for(tab);
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(init_script(tab, gw.port, &gw.token))
        .incognito(false);
    window
        .add_child(
            builder,
            LogicalPosition::new(rect.x, rect.y),
            LogicalSize::new(rect.w, rect.h),
        )
        .map_err(|e| e.to_string())?;
    views.insert(tab, label);
    Ok(())
}

#[tauri::command]
pub fn preview_navigate(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    tab: u32,
    url: String,
) -> Result<(), String> {
    let views = state.views.lock().unwrap();
    let label = views.get(&tab).ok_or("no preview")?;
    let wv = window.get_webview(label).ok_or("no webview")?;
    let u = url.parse().map_err(|e| format!("bad url: {e}"))?;
    wv.navigate(u).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preview_rect(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    tab: u32,
    rect: Rect,
) -> Result<(), String> {
    let views = state.views.lock().unwrap();
    let label = views.get(&tab).ok_or("no preview")?;
    let wv = window.get_webview(label).ok_or("no webview")?;
    wv.set_position(LogicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(rect.w, rect.h))
        .map_err(|e| e.to_string())
}

/// Hide by parking offscreen: child webviews have no reliable hide() across
/// platforms, but a negative position works everywhere.
#[tauri::command]
pub fn preview_visible(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    tab: u32,
    visible: bool,
    rect: Option<Rect>,
) -> Result<(), String> {
    let views = state.views.lock().unwrap();
    let label = match views.get(&tab) {
        Some(l) => l,
        None => return Ok(()),
    };
    let wv = match window.get_webview(label) {
        Some(w) => w,
        None => return Ok(()),
    };
    if visible {
        if let Some(r) = rect {
            let _ = wv.set_position(LogicalPosition::new(r.x, r.y));
            let _ = wv.set_size(LogicalSize::new(r.w, r.h));
        }
    } else {
        let _ = wv.set_position(LogicalPosition::new(-20000.0, -20000.0));
    }
    Ok(())
}

#[tauri::command]
pub fn preview_close(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    tab: u32,
) -> Result<(), String> {
    let mut views = state.views.lock().unwrap();
    if let Some(label) = views.remove(&tab) {
        if let Some(wv) = window.get_webview(&label) {
            let _ = wv.close();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn preview_mode(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    tab: u32,
    mode: String,
    on: bool,
) -> Result<(), String> {
    let views = state.views.lock().unwrap();
    let label = views.get(&tab).ok_or("no preview")?;
    let wv = window.get_webview(label).ok_or("no webview")?;
    let call = match mode.as_str() {
        "pick" => format!("window.__crydeck_pick({on})"),
        "annotate" => format!("window.__crydeck_annotate({on})"),
        "send_annotations" => "window.__crydeck_annotations()".to_string(),
        _ => return Err("bad mode".into()),
    };
    wv.eval(&call).map_err(|e| e.to_string())
}

/// Screenshot the preview's on-screen region (annotations included, since GDI
/// captures what is actually rendered). Returns the PNG path for Claude.
#[tauri::command]
pub fn preview_capture(
    window: tauri::Window,
    state: tauri::State<'_, PreviewState>,
    tab: u32,
) -> Result<String, String> {
    let views = state.views.lock().unwrap();
    let label = views.get(&tab).ok_or("no preview")?;
    let wv = window.get_webview(label).ok_or("no webview")?;
    let pos = wv.position().map_err(|e| e.to_string())?; // physical, window-relative
    let size = wv.size().map_err(|e| e.to_string())?; // physical
    let win = window.inner_position().map_err(|e| e.to_string())?;
    let x = win.x + pos.x;
    let y = win.y + pos.y;
    let (w, h) = (size.width as i32, size.height as i32);
    if w < 4 || h < 4 {
        return Err("preview too small to capture".into());
    }
    let png = capture_screen_region(x, y, w, h)?;
    let out = std::env::temp_dir().join(format!(
        "crydeck-annotation-{tab}-{}.png",
        std::process::id()
    ));
    png.save_with_format(&out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

fn capture_screen_region(x: i32, y: i32, w: i32, h: i32) -> Result<image::RgbaImage, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
    };
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, windows::Win32::Graphics::Gdi::HGDIOBJ(bmp.0));
        let ok = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT).is_ok();

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let got = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, old);
        let _ = DeleteObject(windows::Win32::Graphics::Gdi::HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if !ok || got == 0 {
            return Err("screen capture failed".into());
        }
        // BGRA -> RGBA
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        image::RgbaImage::from_raw(w as u32, h as u32, buf).ok_or("bad capture buffer".into())
    }
}
