use crate::storage::{err, parse};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Saving files out of the app: `common/src/saveApi.ts`, as `desktop/src/saveService.ts` serves it.
/// A file arrives in chunks under a token, into `dir`; `file` then asks the user where it should go
/// and copies it there.
pub fn handle(dir: &Path, endpoint: &str, body: Value, choose: impl FnOnce(&str) -> Option<PathBuf>) -> Result<Value, String> {
  match endpoint {
    "chunk" => {
      let ChunkRequest { token, data, first } = parse(body)?;
      let file = upload(dir, &token)?;
      if first {
        fs::create_dir_all(dir).map_err(err)?;
        let _ = fs::remove_file(&file);
      } else if !file.is_file() {
        return Err(format!("No upload in progress: {token}"));
      }
      let bytes = BASE64.decode(data).map_err(err)?;
      OpenOptions::new().create(true).append(true).open(&file).and_then(|mut f| f.write_all(&bytes)).map_err(err)?;
      Ok(Value::Null)
    }
    // True if saved, false if the user cancelled. The upload is discarded either way.
    "file" => {
      let FileRequest { token, name } = parse(body)?;
      let file = upload(dir, &token)?;
      if !file.is_file() {
        return Err(format!("No upload in progress: {token}"));
      }
      let saved = match choose(&name) {
        Some(destination) => fs::copy(&file, destination).map(|_| true).map_err(err),
        None => Ok(false),
      };
      let _ = fs::remove_file(&file);
      Ok(json!(saved?))
    }
    _ => Err(format!("No endpoint for api/save/{endpoint}")),
  }
}

#[derive(Deserialize)]
struct ChunkRequest {
  token: String,
  data: String,
  first: bool,
}

#[derive(Deserialize)]
struct FileRequest {
  token: String,
  name: String,
}

fn upload(dir: &Path, token: &str) -> Result<PathBuf, String> {
  let fine = !token.is_empty() && token.len() <= 64 && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
  if !fine {
    return Err(format!("Bad token: {token}"));
  }
  Ok(dir.join(token))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn saves_where_the_user_chose() {
    let dir = std::env::temp_dir().join(format!("nexlibris-save-{}", crate::import::new_token()));
    let target = dir.with_extension("out");
    handle(&dir, "chunk", json!({ "token": "t-1", "data": BASE64.encode(b"ab"), "first": true }), |_| None).unwrap();
    handle(&dir, "chunk", json!({ "token": "t-1", "data": BASE64.encode(b"cd"), "first": false }), |_| None).unwrap();
    let saved = handle(&dir, "file", json!({ "token": "t-1", "name": "x.zip", "mimeType": "application/zip" }), |name| {
      assert_eq!(name, "x.zip");
      Some(target.clone())
    });
    assert_eq!(saved.unwrap(), json!(true));
    assert_eq!(fs::read(&target).unwrap(), b"abcd");
    assert!(handle(&dir, "chunk", json!({ "token": "../x", "data": "", "first": true }), |_| None).is_err());
  }
}
