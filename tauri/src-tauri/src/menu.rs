use serde_json::Value;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The menu bar, from the menus the page describes (`common/src/nativeMenu.ts`), as
/// `desktop/src/menu.ts` builds it for Electron: the page's menus, checked, and the app's own (on
/// macOS the app menu, with any items the page marks `appMenu`; Quit elsewhere; the Window menu).

#[derive(Debug, PartialEq)]
pub enum Item {
  Separator,
  Role(String),
  Submenu { label: String, items: Vec<Item> },
  Command { id: String, label: String, accelerator: Option<String>, enabled: bool, checked: Option<bool>, app_menu: bool },
}

#[derive(Debug, PartialEq)]
pub struct PageMenu {
  pub label: String,
  pub items: Vec<Item>,
}

/// Electron's built-in items the page may use (`NATIVE_MENU_ROLES`).
const ROLES: [&str; 11] =
  ["undo", "redo", "cut", "copy", "paste", "reload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen"];

/// Ids of the items the app answers itself (roles without a native item here), apart from the page's.
pub const ROLE_PREFIX: &str = "role:";
pub const PAGE_PREFIX: &str = "page:";

fn text(value: &Value, max: usize) -> Option<String> {
  value.as_str().filter(|s| !s.is_empty() && s.chars().count() <= max).map(str::to_string)
}

/// The page's menus, checked: anything malformed is dropped rather than shown.
pub fn parse(value: &Value) -> Vec<PageMenu> {
  let mut budget = 200i32;
  fn items(value: &Value, depth: usize, budget: &mut i32) -> Vec<Item> {
    let Some(list) = value.as_array().filter(|_| depth <= 3) else { return vec![] };
    let mut parsed = Vec::new();
    for item in list {
      *budget -= 1;
      if *budget < 0 || !item.is_object() {
        break;
      }
      if item["type"] == "separator" {
        parsed.push(Item::Separator);
      } else if let Some(role) = item["role"].as_str().filter(|r| ROLES.contains(r)) {
        parsed.push(Item::Role(role.to_string()));
      } else if let (Some(label), true) = (text(&item["label"], 100), item["submenu"].is_array()) {
        parsed.push(Item::Submenu { label, items: items(&item["submenu"], depth + 1, budget) });
      } else if let (Some(label), Some(id)) = (text(&item["label"], 100), text(&item["id"], 100)) {
        let accelerator = text(&item["accelerator"], 40)
          .filter(|a| a.chars().all(|c| c.is_alphanumeric() || "_+,.=-/".contains(c)));
        let kind = item["kind"].as_str();
        parsed.push(Item::Command {
          id,
          label,
          accelerator,
          enabled: item["enabled"] != false,
          checked: matches!(kind, Some("radio" | "checkbox")).then(|| item["checked"] == true),
          app_menu: item["appMenu"] == true,
        });
      }
    }
    parsed
  }
  let Some(menus) = value.as_array() else { return vec![] };
  menus
    .iter()
    .filter_map(|menu| Some(PageMenu { label: text(&menu["label"], 40)?, items: items(&menu["items"], 0, &mut budget) }))
    .take(10)
    .collect()
}

/// The menu bar: the page's menus and the app's own.
pub fn build<R: Runtime>(app: &AppHandle<R>, menus: &[PageMenu]) -> tauri::Result<Menu<R>> {
  let mac = cfg!(target_os = "macos");
  let mut lifted: Vec<MenuItemKind<R>> = Vec::new();
  let mut about: Option<MenuItemKind<R>> = None;
  let mut top: Vec<MenuItemKind<R>> = Vec::new();
  for menu in menus {
    let items = convert(app, &menu.items, mac, &mut lifted, &mut about)?;
    // A menu whose items all went to the app menu (Help, on macOS) is left out.
    if items.is_empty() {
      continue;
    }
    top.push(MenuItemKind::Submenu(submenu(app, &menu.label, items)?));
  }
  let separator = || PredefinedMenuItem::separator(app).map(MenuItemKind::Predefined);
  if mac {
    // The page's own About, if it lifts one, in place of the system's About panel.
    let first = match about {
      Some(item) => item,
      None => MenuItemKind::Predefined(PredefinedMenuItem::about(app, None, None)?),
    };
    let mut items = vec![first];
    if !lifted.is_empty() {
      items.push(separator()?);
      items.append(&mut lifted);
    }
    items.push(separator()?);
    items.push(MenuItemKind::Predefined(PredefinedMenuItem::services(app, None)?));
    items.push(separator()?);
    items.push(MenuItemKind::Predefined(PredefinedMenuItem::hide(app, None)?));
    items.push(MenuItemKind::Predefined(PredefinedMenuItem::hide_others(app, None)?));
    items.push(MenuItemKind::Predefined(PredefinedMenuItem::show_all(app, None)?));
    items.push(separator()?);
    items.push(MenuItemKind::Predefined(PredefinedMenuItem::quit(app, None)?));
    top.insert(0, MenuItemKind::Submenu(submenu(app, "nexlibris", items)?));
  } else if let Some(MenuItemKind::Submenu(first)) = top.first() {
    first.append(&PredefinedMenuItem::separator(app)?)?;
    first.append(&PredefinedMenuItem::quit(app, None)?)?;
  } else {
    let quit = vec![MenuItemKind::Predefined(PredefinedMenuItem::quit(app, None)?)];
    top.push(MenuItemKind::Submenu(submenu(app, "File", quit)?));
  }
  let window_items = vec![
    MenuItemKind::Predefined(PredefinedMenuItem::minimize(app, None)?),
    MenuItemKind::Predefined(PredefinedMenuItem::maximize(app, None)?),
    separator()?,
    MenuItemKind::Predefined(PredefinedMenuItem::close_window(app, None)?),
  ];
  let window = submenu(app, "Window", window_items)?;
  #[cfg(target_os = "macos")]
  window.set_as_windows_menu_for_nsapp()?;
  top.push(MenuItemKind::Submenu(window));
  let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = top.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
  Menu::with_items(app, &refs)
}

fn submenu<R: Runtime>(app: &AppHandle<R>, label: &str, items: Vec<MenuItemKind<R>>) -> tauri::Result<Submenu<R>> {
  let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
  Submenu::with_items(app, label, true, &refs)
}

fn convert<R: Runtime>(
  app: &AppHandle<R>,
  items: &[Item],
  mac: bool,
  lifted: &mut Vec<MenuItemKind<R>>,
  about: &mut Option<MenuItemKind<R>>,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
  let mut converted: Vec<(bool, MenuItemKind<R>)> = Vec::new();
  for item in items {
    let made = match item {
      Item::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
      Item::Role(role) => role_item(app, role)?,
      Item::Submenu { label, items } => MenuItemKind::Submenu(submenu(app, label, convert(app, items, mac, lifted, about)?)?),
      Item::Command { id, label, accelerator, enabled, checked, app_menu } => {
        let is_about = id == "about";
        let id = format!("{PAGE_PREFIX}{id}");
        let made = match checked {
          Some(checked) => MenuItemKind::Check(CheckMenuItem::with_id(app, id, label, *enabled, *checked, accelerator.as_deref())?),
          None => MenuItemKind::MenuItem(MenuItem::with_id(app, id, label, *enabled, accelerator.as_deref())?),
        };
        if mac && *app_menu && is_about {
          *about = Some(made);
          continue;
        }
        if mac && *app_menu {
          lifted.push(made);
          continue;
        }
        made
      }
    };
    converted.push((matches!(item, Item::Separator), made));
  }
  // Separators left at an end or doubled by lifting items out.
  let mut kept: Vec<MenuItemKind<R>> = Vec::new();
  let count = converted.len();
  let mut previous_separator = true;
  for (i, (separator, item)) in converted.into_iter().enumerate() {
    if separator && (previous_separator || i == count - 1) {
      continue;
    }
    previous_separator = separator;
    kept.push(item);
  }
  if previous_separator && !kept.is_empty() {
    kept.pop();
  }
  Ok(kept)
}

/// A built-in item: the system's own where there is one, else one the app answers (`ROLE_PREFIX`).
fn role_item<R: Runtime>(app: &AppHandle<R>, role: &str) -> tauri::Result<MenuItemKind<R>> {
  let predefined = match role {
    "undo" => Some(PredefinedMenuItem::undo(app, None)?),
    "redo" => Some(PredefinedMenuItem::redo(app, None)?),
    "cut" => Some(PredefinedMenuItem::cut(app, None)?),
    "copy" => Some(PredefinedMenuItem::copy(app, None)?),
    "paste" => Some(PredefinedMenuItem::paste(app, None)?),
    "togglefullscreen" => Some(PredefinedMenuItem::fullscreen(app, None)?),
    _ => None,
  };
  if let Some(item) = predefined {
    return Ok(MenuItemKind::Predefined(item));
  }
  let (label, accelerator) = match role {
    "reload" => ("Reload", "CmdOrCtrl+R"),
    "toggleDevTools" => ("Toggle Developer Tools", "Alt+CmdOrCtrl+I"),
    "resetZoom" => ("Actual Size", "CmdOrCtrl+0"),
    "zoomIn" => ("Zoom In", "CmdOrCtrl+="),
    _ => ("Zoom Out", "CmdOrCtrl+-"),
  };
  Ok(MenuItemKind::MenuItem(MenuItem::with_id(app, format!("{ROLE_PREFIX}{role}"), label, true, Some(accelerator))?))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn drops_what_is_malformed() {
    let menus = parse(&json!([
      { "label": "File", "items": [
        { "id": "open", "label": "Open…", "accelerator": "CmdOrCtrl+O" },
        { "type": "separator" },
        { "role": "copy" },
        { "role": "rm -rf" },
        { "id": "grid", "label": "Grid", "kind": "radio", "checked": true },
        { "id": "bad", "label": "Bad", "accelerator": "Cmd+<script>" },
        { "label": "More", "submenu": [{ "id": "x", "label": "X", "enabled": false, "appMenu": true }] },
      ] },
      { "items": [] },
    ]));
    assert_eq!(menus.len(), 1);
    let items = &menus[0].items;
    assert_eq!(items.len(), 6);
    assert_eq!(items[2], Item::Role("copy".into()));
    assert!(matches!(&items[3], Item::Command { checked: Some(true), .. }));
    assert!(matches!(&items[4], Item::Command { accelerator: None, .. }));
    assert!(matches!(&items[5], Item::Submenu { items, .. } if matches!(&items[0], Item::Command { enabled: false, app_menu: true, .. })));
  }
}
