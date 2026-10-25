use crate::paths::resolve;
use crate::storage::{err, make_parent, parse};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Importing files: `common/src/importApi.ts`, as `desktop/src/importService.ts` serves it. Picked
/// files are copied straight into the library's stored files, hashed as they're copied.
#[derive(Default)]
pub struct Imports {
  /// The latest pick, for `store`: each chosen file with where it is on disk.
  latest: Option<(String, Vec<(Chosen, PathBuf)>)>,
}

#[derive(Serialize, Clone)]
struct Chosen {
  name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  path: Option<String>,
  size: u64,
}

#[derive(Serialize)]
struct Skipped {
  name: String,
  reason: String,
}

#[derive(Deserialize)]
struct PickRequest {
  extensions: Vec<String>,
  #[serde(default)]
  folder: bool,
  #[serde(default)]
  names: Vec<String>,
}

#[derive(Deserialize)]
struct StoreRequest {
  token: String,
  start: usize,
}

const STORE_BATCH_FILES: usize = 50;
const STORE_BATCH_BYTES: u64 = 32 * 1024 * 1024;

impl Imports {
  /// `choose` asks the user for files (offering these extensions) or a folder: the chosen paths, empty if they cancel.
  pub fn handle(
    &mut self,
    data_dir: &Path,
    endpoint: &str,
    body: Value,
    choose: impl FnOnce(&[String], bool) -> Vec<PathBuf>,
  ) -> Result<Value, String> {
    match endpoint {
      "pick" => {
        let PickRequest { extensions, folder, names } = parse(body)?;
        let suffixes: Vec<String> = extensions.iter().map(|e| format!(".{}", e.to_lowercase())).collect();
        let wanted: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
        let mut picked: Vec<(PathBuf, Option<String>)> = Vec::new();
        for chosen in choose(&extensions, folder) {
          if !folder {
            picked.push((chosen, None));
            continue;
          }
          let prefix = file_name(&chosen);
          let mut found = Vec::new();
          walk(&chosen, &prefix, &mut found);
          picked.extend(found.into_iter().map(|(file, path)| (file, Some(path))));
        }
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        for (source, path) in picked {
          let name = file_name(&source);
          let lower = name.to_lowercase();
          if !suffixes.iter().any(|s| lower.ends_with(s)) && !(folder && wanted.contains(&lower)) {
            skipped.push(Skipped { name: path.unwrap_or(name), reason: "unsupported file type".into() });
            continue;
          }
          let size = fs::metadata(&source).map(|m| m.len()).unwrap_or(0);
          files.push((Chosen { name, path, size }, source));
        }
        let token = new_token();
        let listed: Vec<Chosen> = files.iter().map(|(chosen, _)| chosen.clone()).collect();
        self.latest = Some((token.clone(), files));
        Ok(json!({ "token": token, "files": listed, "skipped": skipped }))
      }
      "store" => {
        let StoreRequest { token, start } = parse(body)?;
        let files = match &self.latest {
          Some((latest, files)) if *latest == token => files,
          _ => return Err("This import was replaced by another; pick the files again.".into()),
        };
        let mut stored = Vec::new();
        let mut skipped = Vec::new();
        let (mut next, mut bytes) = (start, 0);
        while next < files.len() && next - start < STORE_BATCH_FILES && bytes < STORE_BATCH_BYTES {
          let (chosen, source) = &files[next];
          next += 1;
          match File::open(source).map_err(err).and_then(|f| store(data_dir, f)) {
            Ok((hash, size)) => {
              bytes += size;
              let mut file = serde_json::to_value(chosen).map_err(err)?;
              file["hash"] = json!(hash);
              file["size"] = json!(size);
              stored.push(file);
            }
            Err(reason) => skipped.push(Skipped { name: chosen.path.clone().unwrap_or(chosen.name.clone()), reason }),
          }
        }
        let done = next >= files.len();
        if done {
          self.latest = None;
        }
        Ok(json!({ "files": stored, "skipped": skipped, "next": next }))
      }
      _ => Err(format!("No endpoint for api/import/{endpoint}")),
    }
  }
}

fn file_name(path: &Path) -> String {
  path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The files in a folder and its subfolders, as paths from `prefix`, in name order; hidden ones and symlinks left out.
fn walk(dir: &Path, prefix: &str, found: &mut Vec<(PathBuf, String)>) {
  let Ok(entries) = fs::read_dir(dir) else { return };
  let mut entries: Vec<_> = entries.flatten().collect();
  entries.sort_by_key(|e| e.file_name());
  for entry in entries {
    let name = entry.file_name().to_string_lossy().into_owned();
    let Ok(kind) = entry.file_type() else { continue };
    if name.starts_with('.') {
      continue;
    }
    if kind.is_dir() {
      walk(&entry.path(), &format!("{prefix}/{name}"), found);
    } else if kind.is_file() {
      found.push((entry.path(), format!("{prefix}/{name}")));
    }
  }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Names an upload or a pick: unique within this run, letters, digits and dashes.
pub fn new_token() -> String {
  let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
  format!("{nanos:x}-{:x}-{:x}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Stores bytes as a content-addressed file (`files/<2>/<hash>`), hashing them as they're written;
/// contents already stored are a no-op. With `expected`, other contents are refused. Returns the hash and size.
pub fn store_checked(data_dir: &Path, mut source: impl Read, expected: Option<&str>, max: u64) -> Result<(String, u64), String> {
  let files = resolve(data_dir, "files")?;
  fs::create_dir_all(&files).map_err(err)?;
  let temp = files.join(format!(".import-{}.tmp", new_token()));
  let result = (|| {
    let mut out = File::create(&temp).map_err(err)?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
      let read = source.read(&mut buffer).map_err(err)?;
      if read == 0 {
        break;
      }
      size += read as u64;
      if size > max {
        return Err("That file is too big.".to_string());
      }
      hash.update(&buffer[..read]);
      out.write_all(&buffer[..read]).map_err(err)?;
    }
    out.sync_all().map_err(err)?;
    Ok((hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>(), size))
  })();
  let (digest, size) = match result {
    Ok(done) => done,
    Err(e) => {
      let _ = fs::remove_file(&temp);
      return Err(e);
    }
  };
  if let Some(expected) = expected.filter(|e| *e != digest) {
    let _ = fs::remove_file(&temp);
    return Err(format!("The file's contents don't match its hash (expected {}…).", &expected[..12.min(expected.len())]));
  }
  let file = resolve(data_dir, &format!("files/{}/{digest}", &digest[..2]))?;
  if file.is_file() {
    let _ = fs::remove_file(&temp);
  } else {
    make_parent(&file)?;
    fs::rename(&temp, &file).map_err(err)?;
  }
  Ok((digest, size))
}

fn store(data_dir: &Path, source: impl Read) -> Result<(String, u64), String> {
  store_checked(data_dir, source, None, u64::MAX)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::paths::real_dir;

  #[test]
  fn picks_and_stores_files_by_hash() {
    let base = real_dir(&std::env::temp_dir().join(format!("nexlibris-import-{}", new_token()))).unwrap();
    let library = real_dir(&base.join("library")).unwrap();
    let picked = base.join("Books");
    fs::create_dir_all(picked.join("Herbert")).unwrap();
    fs::write(picked.join("Herbert/Dune.epub"), b"dune").unwrap();
    fs::write(picked.join("Herbert/metadata.opf"), b"<opf/>").unwrap();
    fs::write(picked.join("notes.txt"), b"x").unwrap();
    fs::write(picked.join(".hidden.epub"), b"x").unwrap();

    let mut imports = Imports::default();
    let body = json!({ "extensions": ["epub"], "folder": true, "names": ["metadata.opf"] });
    let pick = imports.handle(&library, "pick", body, |_, _| vec![picked.clone()]).unwrap();
    let paths: Vec<&str> = pick["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["Books/Herbert/Dune.epub", "Books/Herbert/metadata.opf"]);
    assert_eq!(pick["skipped"][0]["name"], "Books/notes.txt");

    let stored = imports.handle(&library, "store", json!({ "token": pick["token"], "start": 0 }), |_, _| vec![]).unwrap();
    assert_eq!(stored["next"], 2);
    let hash = stored["files"][0]["hash"].as_str().unwrap();
    assert_eq!(hash, "ab906be12ca6d9f28ad5687f2b0ab8bc5e4535060485ee9c6eec3580777424ee");
    assert_eq!(fs::read(library.join("files").join(&hash[..2]).join(hash)).unwrap(), b"dune");
    assert!(imports.handle(&library, "store", json!({ "token": pick["token"], "start": 0 }), |_, _| vec![]).is_err());
  }
}
