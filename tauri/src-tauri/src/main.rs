// No console window alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! nexlibris as a desktop app in the system's web view (Tauri): a prototype beside the Electron
//! app in `desktop/`, with the same page and the same `window.NexlibrisDesktop` (`bridge.js`),
//! answered here in Rust instead of Node. Not here yet: hosting sync (`desktop/src/syncHost.ts`),
//! moving the library between folders, and calling a nexlibris server through the app.

mod import;
mod menu;
mod paths;
mod remote;
mod save;
mod storage;

use paths::{data_dir, is_placed, real_dir, resolve};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, RwLock};
use tauri::http::{header, Response, StatusCode};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalPosition, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const SCHEME: &str = "app";
const LIBRARY_WINDOW: &str = "library";
const BRIDGE: &str = include_str!("bridge.js");

/// What's open: the library's folder (a real path) and whether it's laid out (a folder of the user's).
struct Library {
  dir: PathBuf,
  placed: bool,
}

struct State {
  /// The built web client.
  client: PathBuf,
  /// The library in the app's data folder, where it is unless one was chosen.
  default_dir: PathBuf,
  /// Where the chosen library is remembered (`{ "libraryDir": … }`).
  settings: PathBuf,
  library: RwLock<Library>,
  imports: Mutex<import::Imports>,
  saves: PathBuf,
  /// Calls run one at a time, in order, as in the Electron app: an append must not overtake the write before it.
  queue: tokio::sync::Mutex<()>,
  /// Each window's full screen, as last told to its page.
  full_screen: Mutex<HashMap<String, bool>>,
  /// Books' windows by the name the page opened them with (`nexlibris-read-<item>`), to focus again.
  readers: Mutex<HashMap<String, String>>,
  zoom: Mutex<f64>,
}

fn open_library(dir: &Path) -> Result<Library, String> {
  let dir = real_dir(dir)?;
  Ok(Library { placed: is_placed(&dir), dir })
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
  #[serde(skip_serializing_if = "Option::is_none")]
  library_dir: Option<PathBuf>,
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
      let app = context.app_handle().clone();
      // Off the main thread: files can be large.
      std::thread::spawn(move || responder.respond(serve(&app, request.uri().path())));
    })
    .invoke_handler(tauri::generate_handler![rpc, open_reader, set_menu, set_full_screen, start_dragging, toggle_zoom])
    .setup(|app| {
      let data = app.path().app_data_dir()?;
      let settings = data.join("settings.json");
      let default_dir = data.join("library");
      let chosen: Settings = fs::read_to_string(&settings).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
      let dir = std::env::var_os("NEXLIBRIS_LIBRARY_DIR").map(PathBuf::from).or(chosen.library_dir).unwrap_or(default_dir.clone());
      let saves = app.path().temp_dir()?.join("nexlibris-save");
      // Anything there is from an earlier run that never finished.
      let _ = fs::remove_dir_all(&saves);
      app.manage(State {
        client: client_dir(app.handle()),
        default_dir,
        settings,
        library: RwLock::new(open_library(&dir)?),
        imports: Mutex::new(import::Imports::default()),
        saves,
        queue: tokio::sync::Mutex::new(()),
        full_screen: Mutex::new(HashMap::new()),
        readers: Mutex::new(HashMap::new()),
        zoom: Mutex::new(1.0),
      });
      app.set_menu(menu::build(app.handle(), &[])?)?;
      app.on_menu_event(on_menu);
      library_window(app.handle())?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("nexlibris failed to start");
}

/// The built client: `NEXLIBRIS_CLIENT_DIR`, else the copy bundled with the app, else the repo's `client/dist`.
fn client_dir(app: &AppHandle) -> PathBuf {
  if let Some(dir) = std::env::var_os("NEXLIBRIS_CLIENT_DIR") {
    return PathBuf::from(dir);
  }
  let bundled = app.path().resource_dir().map(|d| d.join("www"));
  match bundled {
    Ok(dir) if dir.join("index.html").is_file() => dir,
    _ => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../client/dist"),
  }
}

/// A request to the app's origin: a library file or thumbnail (`/library/…`, as `NativeStorage`
/// fetches them), or a file of the built client, with `index.html` for paths that aren't files.
fn serve(app: &AppHandle, raw: &str) -> Response<Vec<u8>> {
  let state = app.state::<State>();
  let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(b"Not found".to_vec()).unwrap();
  let Ok(path) = percent_encoding::percent_decode_str(raw).decode_utf8() else { return not_found() };
  let path = path.trim_start_matches('/');
  if path == "server" || path.starts_with("server/") {
    let body = json!({ "status": "error", "message": "The Tauri prototype doesn't reach nexlibris servers yet." });
    return Response::builder()
      .status(StatusCode::NOT_IMPLEMENTED)
      .header(header::CONTENT_TYPE, "application/json")
      .body(body.to_string().into_bytes())
      .unwrap();
  }
  let file = if let Some(inner) = path.strip_prefix("library/") {
    let library = state.library.read().unwrap();
    if !paths::served(inner, library.placed) {
      return not_found();
    }
    match resolve(&library.dir, inner) {
      Ok(file) if file.is_file() => file,
      _ => return not_found(),
    }
  } else {
    let Ok(client) = state.client.canonicalize() else { return not_found() };
    match resolve(&client, if path.is_empty() { "index.html" } else { path }) {
      Ok(file) if file.is_file() => file,
      // A client route rather than a file: the single page handles it.
      _ => client.join("index.html"),
    }
  };
  match fs::read(&file) {
    Ok(bytes) => Response::builder()
      .header(header::CONTENT_TYPE, content_type(&file))
      .header(header::CACHE_CONTROL, "no-cache")
      .body(bytes)
      .unwrap(),
    Err(_) => not_found(),
  }
}

fn content_type(file: &Path) -> &'static str {
  match file.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
    Some("html") => "text/html; charset=utf-8",
    Some("js" | "mjs") => "text/javascript; charset=utf-8",
    Some("css") => "text/css; charset=utf-8",
    Some("json") => "application/json",
    Some("wasm") => "application/wasm",
    Some("png") => "image/png",
    Some("jpg" | "jpeg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("webp") => "image/webp",
    Some("svg") => "image/svg+xml",
    Some("ttf") => "font/ttf",
    Some("otf") => "font/otf",
    Some("woff2") => "font/woff2",
    _ => "application/octet-stream",
  }
}

#[derive(Deserialize)]
struct RpcRequest {
  method: String,
  url: String,
  body: Value,
}

/// An estuary-rpc call from the page (`common/src/rpc.ts`), answered as `createMessageHandler` does.
#[tauri::command]
async fn rpc(app: AppHandle, webview: tauri::Webview, request: RpcRequest) -> Value {
  if !is_app_page(&webview) {
    return json!({ "ok": false, "message": "Not allowed" });
  }
  let state = app.state::<State>();
  let _turn = state.queue.lock().await;
  let window = webview.label().to_string();
  let handle = app.clone();
  let result = tauri::async_runtime::spawn_blocking(move || route(&handle, &window, request)).await;
  match result {
    Ok(Ok(value)) => json!({ "ok": true, "value": value }),
    Ok(Err(message)) => json!({ "ok": false, "message": message }),
    Err(e) => json!({ "ok": false, "message": e.to_string() }),
  }
}

fn route(app: &AppHandle, window: &str, RpcRequest { method, url, body }: RpcRequest) -> Result<Value, String> {
  let state = app.state::<State>();
  let (group, endpoint) = url.strip_prefix("api/").and_then(|rest| rest.split_once('/')).ok_or(format!("No endpoint for {method} {url}"))?;
  let (dir, placed) = {
    let library = state.library.read().unwrap();
    (library.dir.clone(), library.placed)
  };
  let parent = app.get_webview_window(window);
  match group {
    "storage" => storage::handle(&dir, endpoint, body),
    "import" => state.imports.lock().unwrap().handle(&data_dir(&dir), endpoint, body, |extensions, folder| {
      let mut dialog = app.dialog().file();
      if let Some(parent) = &parent {
        dialog = dialog.set_parent(parent);
      }
      let picked = if folder {
        dialog.set_title("Import").blocking_pick_folder().map(|f| vec![f])
      } else {
        // A dialog filter matches the last part of a name, so `x4.epub` is offered as `epub`.
        let mut last: Vec<&str> = extensions.iter().map(|e| e.rsplit('.').next().unwrap_or(e)).collect();
        last.dedup();
        dialog.add_filter("Books", &last).blocking_pick_files()
      };
      picked.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect()
    }),
    "save" => save::handle(&state.saves, endpoint, body, |name| {
      let mut dialog = app.dialog().file().set_file_name(name);
      if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
      }
      if let Some(parent) = &parent {
        dialog = dialog.set_parent(parent);
      }
      dialog.blocking_save_file().and_then(|f| f.into_path().ok())
    }),
    "remote" => remote::handle(&data_dir(&dir), endpoint, body),
    "libraryFolder" => library_folder(app, endpoint, body, &dir, placed),
    "syncHost" => match endpoint {
      "status" => Ok(json!({
        "enabled": false,
        "name": "",
        "addresses": [],
        "peers": [],
        "error": "The Tauri prototype doesn't host sync yet.",
      })),
      _ => Err("The Tauri prototype doesn't host sync yet.".into()),
    },
    _ => Err(format!("No endpoint for {method} {url}")),
  }
}

#[derive(Deserialize)]
struct PathBody {
  path: String,
}

#[derive(Deserialize)]
struct MoveBody {
  from: String,
  to: String,
}

const IGNORED: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// `common/src/libraryFolderApi.ts`, as `desktop/src/main.ts` answers it, except moving the library.
fn library_folder(app: &AppHandle, endpoint: &str, body: Value, dir: &Path, placed: bool) -> Result<Value, String> {
  let state = app.state::<State>();
  let holds = |folder: &Path| {
    if is_placed(folder) || folder.join("library.json").is_file() {
      return "library";
    }
    let any = fs::read_dir(folder).map(|d| d.flatten().any(|e| !IGNORED.contains(&&*e.file_name().to_string_lossy()))).unwrap_or(false);
    if any { "files" } else { "nothing" }
  };
  match endpoint {
    "location" => {
      let is_default = state.default_dir.canonicalize().map(|d| d == dir).unwrap_or(false);
      let default_has_library = !is_default && state.default_dir.is_dir() && holds(&state.default_dir) == "library";
      Ok(json!({ "path": dir, "isDefault": is_default, "placed": placed, "defaultHasLibrary": default_has_library }))
    }
    "choose" => {
      let picked = app.dialog().file().set_title("Choose").blocking_pick_folder().and_then(|f| f.into_path().ok());
      Ok(picked.map_or(Value::Null, |path| json!({ "path": path, "holds": holds(&path) })))
    }
    "status" => Ok(json!({ "state": "idle", "done": 0, "total": 0 })),
    "move" => Err("The Tauri prototype can't move the library yet; use the Electron app for that.".into()),
    "open" => {
      if std::env::var_os("NEXLIBRIS_LIBRARY_DIR").is_some() {
        return Err("NEXLIBRIS_LIBRARY_DIR sets where the library is; unset it to open another.".into());
      }
      let path = body.get("path").and_then(Value::as_str).map(PathBuf::from);
      let settings = Settings { library_dir: path.clone() };
      fs::create_dir_all(state.settings.parent().unwrap()).map_err(storage::err)?;
      fs::write(&state.settings, serde_json::to_string(&settings).unwrap()).map_err(storage::err)?;
      *state.library.write().unwrap() = open_library(&path.unwrap_or(state.default_dir.clone()))?;
      // Book windows close, and the library's window loads again.
      for (label, window) in app.webview_windows() {
        if label == LIBRARY_WINDOW {
          let _ = window.reload();
        } else {
          let _ = window.close();
        }
      }
      Ok(Value::Null)
    }
    "moveFile" => {
      let MoveBody { from, to } = storage::parse(body)?;
      let target = resolve(dir, &to)?;
      storage::make_parent(&target)?;
      fs::rename(resolve(dir, &from)?, target).map_err(storage::err)?;
      Ok(Value::Null)
    }
    "prune" => {
      let PathBody { path } = storage::parse(body)?;
      let mut folder = resolve(dir, &path)?.parent().map(Path::to_path_buf);
      while let Some(current) = folder.filter(|f| f != dir && f.starts_with(dir)) {
        let Ok(entries) = fs::read_dir(&current) else { break };
        let names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        if names.iter().any(|n| !IGNORED.contains(&n.as_str())) {
          break;
        }
        for name in names {
          let _ = fs::remove_file(current.join(name));
        }
        let _ = fs::remove_dir(&current);
        folder = current.parent().map(Path::to_path_buf);
      }
      Ok(Value::Null)
    }
    "showFile" => {
      let PathBody { path } = storage::parse(body)?;
      let file = resolve(dir, &path)?;
      if !file.is_file() {
        return Err("The file isn’t in the library’s folder.".into());
      }
      app.opener().reveal_item_in_dir(file).map_err(storage::err)?;
      Ok(Value::Null)
    }
    _ => Err(format!("No endpoint for api/libraryFolder/{endpoint}")),
  }
}

/// Only the app's own pages (not a book's content or anything they navigated to) call the app.
fn is_app_page(webview: &tauri::Webview) -> bool {
  webview.url().map(|url| url.scheme() == SCHEME).unwrap_or(false)
}

#[tauri::command]
fn set_menu(app: AppHandle, webview: tauri::Webview, menus: Value) -> Result<(), String> {
  if !is_app_page(&webview) || webview.label() != LIBRARY_WINDOW {
    return Ok(());
  }
  let menu = menu::build(&app, &menu::parse(&menus)).map_err(storage::err)?;
  app.set_menu(menu).map_err(storage::err)?;
  Ok(())
}

/// Opens a book in a window of its own, or focuses the one already showing it (the page's
/// `window.open` of a book, `client/src/library/readerWindow.ts`, comes here through bridge.js).
/// A window the web view opens itself would share its opener's configuration, and with it Tauri's
/// handlers, so its calls would come from the library's window (dragging that window, say).
#[tauri::command]
fn open_reader(app: AppHandle, webview: tauri::Webview, url: String, name: String) -> Result<(), String> {
  if !is_app_page(&webview) {
    return Err("Not allowed".into());
  }
  let url: Url = url.parse().map_err(storage::err)?;
  if url.scheme() != SCHEME || !url.query_pairs().any(|(key, _)| key == "read") {
    return Err("Not a book's address".into());
  }
  let state = app.state::<State>();
  let mut readers = state.readers.lock().unwrap();
  if let Some(window) = readers.get(&name).and_then(|label| app.get_webview_window(label)) {
    let _ = window.unminimize();
    return window.set_focus().map_err(storage::err);
  }
  let label = format!("reader-{}", READER_WINDOWS.fetch_add(1, Ordering::Relaxed));
  let window = window_builder(&app, &label, WebviewUrl::CustomProtocol(url), true)
    .inner_size(960.0, 1100.0)
    .build()
    .map_err(storage::err)?;
  follow_full_screen(&window);
  if !name.is_empty() {
    readers.insert(name, label);
  }
  Ok(())
}

/// The page's own full screen (epubier's) is the window's.
#[tauri::command]
fn set_full_screen(window: WebviewWindow, on: bool) {
  let _ = window.set_fullscreen(on);
}

/// The top bar moves the window (`bridge.js` finds where it's dragged).
#[tauri::command]
fn start_dragging(window: WebviewWindow) {
  let _ = window.start_dragging();
}

/// A double click on the top bar zooms the window, as on a title bar.
#[tauri::command]
fn toggle_zoom(window: WebviewWindow) {
  let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() };
}

fn on_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
  let id = event.id().0.as_str();
  if let Some(command) = id.strip_prefix(menu::PAGE_PREFIX) {
    // The menus are the library window's commands, so they go to it, even from a book's own window.
    if let Some(window) = app.get_webview_window(LIBRARY_WINDOW) {
      let _ = window.set_focus();
      let _ = window.eval(format!("window.__nexlibris?.menu({})", json!(command)));
    }
    return;
  }
  let Some(role) = id.strip_prefix(menu::ROLE_PREFIX) else { return };
  let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
  let Some(window) = focused.or_else(|| app.get_webview_window(LIBRARY_WINDOW)) else { return };
  let state = app.state::<State>();
  let mut zoom = state.zoom.lock().unwrap();
  match role {
    "reload" => {
      let _ = window.reload();
    }
    "toggleDevTools" => {
      #[cfg(debug_assertions)]
      if window.is_devtools_open() {
        window.close_devtools();
      } else {
        window.open_devtools();
      }
    }
    "resetZoom" => *zoom = 1.0,
    "zoomIn" => *zoom = (*zoom * 1.1).min(3.0),
    "zoomOut" => *zoom = (*zoom / 1.1).max(0.3),
    _ => {}
  }
  if role.contains("oom") {
    for window in app.webview_windows().values() {
      let _ = window.set_zoom(*zoom);
    }
  }
}

static READER_WINDOWS: AtomicU32 = AtomicU32::new(1);

/// What every window of the app has: the bridge, links out of the app opened in the browser, books
/// in windows of their own, and on macOS no title bar (the window buttons sit in the page's top bar).
fn window_builder<'a>(app: &'a AppHandle, label: &str, url: WebviewUrl, reader: bool) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
  let opener = app.clone();
  let opens = app.clone();
  let mut builder = WebviewWindowBuilder::new(app, label, url)
    .title("nexlibris")
    .initialization_script(BRIDGE)
    // Shown once the page has painted, so there's no flash of white before it.
    .visible(false)
    .on_page_load(|window, payload| {
      if payload.event() == PageLoadEvent::Finished {
        let _ = window.show();
      }
    })
    .on_navigation(move |url| {
      if !is_web(url) {
        return true;
      }
      let _ = opener.opener().open_url(url.as_str(), None::<&str>);
      false
    })
    // Books' windows are opened by `open_reader` (bridge.js); anything else the page opens is a link out.
    .on_new_window(move |url, _| {
      if is_web(&url) {
        let _ = opens.opener().open_url(url.as_str(), None::<&str>);
      }
      NewWindowResponse::Deny
    });
  #[cfg(target_os = "macos")]
  {
    // Centred on the library's top bar, or on epubier's toolbar, which is a little shorter. Electron
    // puts the buttons' tops at 21 and 18; tao makes the title bar `y` plus the buttons' height and
    // leaves AppKit's 9 points below them, so the same places are 9 further down here.
    let y = if reader { 27.0 } else { 30.0 };
    builder = builder
      .title_bar_style(tauri::TitleBarStyle::Overlay)
      .hidden_title(true)
      .traffic_light_position(LogicalPosition::new(18.0, y));
  }
  #[cfg(not(target_os = "macos"))]
  let _ = reader;
  builder
}

fn is_web(url: &Url) -> bool {
  url.scheme() == "http" || url.scheme() == "https"
}

fn library_window(app: &AppHandle) -> tauri::Result<()> {
  let url = format!("{SCHEME}://localhost/").parse().expect("the app's address");
  let window = window_builder(app, LIBRARY_WINDOW, WebviewUrl::CustomProtocol(url), false).inner_size(1280.0, 860.0).build()?;
  follow_full_screen(&window);
  Ok(())
}

/// Tells the page as the window enters or leaves full screen, where the window buttons hide.
fn follow_full_screen(window: &WebviewWindow) {
  let watched = window.clone();
  window.on_window_event(move |event| {
    if !matches!(event, WindowEvent::Resized(_)) {
      return;
    }
    let on = watched.is_fullscreen().unwrap_or(false);
    let state = watched.state::<State>();
    let mut known = state.full_screen.lock().unwrap();
    if known.insert(watched.label().to_string(), on) != Some(on) {
      let _ = watched.eval(format!("window.__nexlibris?.fullScreen({on})"));
    }
  });
}
