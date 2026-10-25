use crate::paths::resolve;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// The library's files on disk: the storage API in `common/src/storageApi.ts`, as
/// `desktop/src/fileStorage.ts` serves it in the Electron app. Whole-file writes go to a temporary
/// file that's moved into place, so a reader never sees a partial file.
pub fn handle(root: &Path, endpoint: &str, body: Value) -> Result<Value, String> {
  match endpoint {
    "readText" => {
      let file = resolve(root, &path_of(body)?)?;
      if !file.is_file() {
        return Ok(Value::Null);
      }
      Ok(json!(fs::read_to_string(file).map_err(err)?))
    }
    "writeText" => {
      let TextRequest { path, text } = parse(body)?;
      let file = resolve(root, &path)?;
      make_parent(&file)?;
      let temp = sibling(&file, "tmp");
      write_synced(&temp, text.as_bytes(), false)?;
      fs::rename(temp, file).map_err(err)?;
      Ok(Value::Null)
    }
    "appendText" => {
      let TextRequest { path, text } = parse(body)?;
      let file = resolve(root, &path)?;
      make_parent(&file)?;
      // The change log is appended to; each append is durable before it's reported.
      write_synced(&file, text.as_bytes(), true)?;
      Ok(Value::Null)
    }
    "exists" => Ok(json!(resolve(root, &path_of(body)?)?.is_file())),
    "size" => {
      let file = resolve(root, &path_of(body)?)?;
      Ok(match fs::metadata(file) {
        Ok(info) if info.is_file() => json!(info.len()),
        _ => Value::Null,
      })
    }
    "readChunk" => {
      let ChunkReadRequest { path, offset, length } = parse(body)?;
      let file = resolve(root, &path)?;
      if !file.is_file() {
        return Err(format!("No file: {path}"));
      }
      let mut handle = File::open(file).map_err(err)?;
      handle.seek(SeekFrom::Start(offset)).map_err(err)?;
      let mut buffer = Vec::with_capacity(length as usize);
      handle.take(length).read_to_end(&mut buffer).map_err(err)?;
      Ok(json!(BASE64.encode(buffer)))
    }
    "writeChunk" => {
      let ChunkWriteRequest { path, data, first, last } = parse(body)?;
      let file = resolve(root, &path)?;
      let upload = sibling(&file, "upload");
      if first {
        make_parent(&file)?;
        let _ = fs::remove_file(&upload);
      } else if !upload.is_file() {
        return Err(format!("No upload in progress: {path}"));
      }
      let bytes = BASE64.decode(data).map_err(err)?;
      OpenOptions::new().create(true).append(true).open(&upload).and_then(|mut f| f.write_all(&bytes)).map_err(err)?;
      if last {
        File::open(&upload).and_then(|f| f.sync_all()).map_err(err)?;
        fs::rename(upload, file).map_err(err)?;
      }
      Ok(Value::Null)
    }
    "remove" => {
      let path = path_of(body)?;
      let file = resolve(root, &path)?;
      match fs::metadata(&file) {
        Ok(info) if info.is_dir() => Err(format!("Not a file: {path}")),
        Ok(_) => fs::remove_file(file).map(|_| Value::Null).map_err(err),
        Err(_) => Ok(Value::Null),
      }
    }
    _ => Err(format!("No endpoint for api/storage/{endpoint}")),
  }
}

#[derive(Deserialize)]
struct PathRequest {
  path: String,
}

#[derive(Deserialize)]
struct TextRequest {
  path: String,
  text: String,
}

#[derive(Deserialize)]
struct ChunkReadRequest {
  path: String,
  offset: u64,
  length: u64,
}

#[derive(Deserialize)]
struct ChunkWriteRequest {
  path: String,
  data: String,
  first: bool,
  last: bool,
}

pub fn parse<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, String> {
  serde_json::from_value(body).map_err(|e| format!("Bad request: {e}"))
}

fn path_of(body: Value) -> Result<String, String> {
  parse::<PathRequest>(body).map(|r| r.path)
}

pub fn err(e: impl std::fmt::Display) -> String {
  e.to_string()
}

pub fn make_parent(file: &Path) -> Result<(), String> {
  fs::create_dir_all(file.parent().ok_or("No folder")?).map_err(err)
}

/// `.<name>.<suffix>` beside `file`, for writing before it's moved into place.
fn sibling(file: &Path, suffix: &str) -> PathBuf {
  let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
  file.with_file_name(format!(".{name}.{suffix}"))
}

fn write_synced(file: &Path, data: &[u8], append: bool) -> Result<(), String> {
  let mut handle = OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(file).map_err(err)?;
  handle.write_all(data).map_err(err)?;
  handle.sync_all().map_err(err)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::paths::real_dir;

  #[test]
  fn writes_reads_and_removes() {
    let root = real_dir(&std::env::temp_dir().join("nexlibris-storage-test")).unwrap();
    let call = |endpoint: &str, body: Value| handle(&root, endpoint, body).unwrap();
    call("writeText", json!({ "path": "a/b.json", "text": "hello" }));
    call("appendText", json!({ "path": "a/b.json", "text": " world" }));
    assert_eq!(call("readText", json!({ "path": "a/b.json" })), json!("hello world"));
    assert_eq!(call("size", json!({ "path": "a/b.json" })), json!(11));
    call("writeChunk", json!({ "path": "f/x", "data": BASE64.encode(b"abc"), "first": true, "last": false }));
    call("writeChunk", json!({ "path": "f/x", "data": BASE64.encode(b"def"), "first": false, "last": true }));
    assert_eq!(call("readChunk", json!({ "path": "f/x", "offset": 2, "length": 3 })), json!(BASE64.encode(b"cde")));
    call("remove", json!({ "path": "f/x" }));
    assert_eq!(call("exists", json!({ "path": "f/x" })), json!(false));
    assert_eq!(call("readText", json!({ "path": "none" })), Value::Null);
    assert!(handle(&root, "readText", json!({ "path": "../x" })).is_err());
  }
}
