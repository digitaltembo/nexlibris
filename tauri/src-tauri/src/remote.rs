use crate::import::store_checked;
use crate::storage::{err, parse};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use ureq::ResponseExt;

/// Fetching from the web for the page (OPDS catalogs and their books), which CORS would stop:
/// `common/src/remoteApi.ts`, as `desktop/src/remote.ts` serves it. Only http and https.
pub fn handle(data_dir: &Path, endpoint: &str, body: Value) -> Result<Value, String> {
  let RemoteRequest { url, headers } = parse(body)?;
  if !(url.starts_with("http://") || url.starts_with("https://")) {
    return Err(format!("Not a web address: {url}"));
  }
  let timeout = if endpoint == "download" { 10 * TIMEOUT } else { TIMEOUT };
  let agent: ureq::Agent = ureq::Agent::config_builder()
    .http_status_as_error(false)
    .timeout_global(Some(timeout))
    .build()
    .into();
  let mut request = agent.get(&url);
  for (name, value) in &headers {
    request = request.header(name, value);
  }
  let mut response = request.call().map_err(err)?;
  let status = response.status().as_u16();
  let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
  let kind = header("content-type").and_then(|t| t.split(';').next().map(|t| t.trim().to_string()));
  match endpoint {
    "fetchText" => {
      let mut reply = Map::new();
      if let Some(etag) = header("etag") {
        reply.insert("etag".into(), json!(etag));
      }
      if let Some(modified) = header("last-modified") {
        reply.insert("lastModified".into(), json!(modified));
      }
      reply.insert("status".into(), json!(status));
      reply.insert("url".into(), json!(response.get_uri().to_string()));
      let text = response
        .body_mut()
        .with_config()
        .limit(MAX_TEXT_BYTES)
        .read_to_string()
        .map_err(|_| "That page is too big to be a catalog.".to_string())?;
      reply.insert("text".into(), json!(text));
      Ok(Value::Object(reply))
    }
    "fetchBytes" => {
      let bytes = response.body_mut().with_config().limit(MAX_BYTES).read_to_vec().map_err(|_| "That image is too big.".to_string())?;
      let mut reply = json!({ "status": status, "data": BASE64.encode(bytes) });
      if let Some(kind) = kind {
        reply["type"] = json!(kind);
      }
      Ok(reply)
    }
    "download" => {
      if !(200..300).contains(&status) {
        return Err(format!("The server said {status}."));
      }
      let name = download_name(header("content-disposition").as_deref(), &response.get_uri().to_string());
      let reader = response.into_body().into_with_config().limit(MAX_DOWNLOAD_BYTES).reader();
      let (hash, size) = store_checked(data_dir, reader, None, MAX_DOWNLOAD_BYTES)?;
      let mut reply = json!({ "hash": hash, "size": size, "name": name });
      if let Some(kind) = kind {
        reply["type"] = json!(kind);
      }
      Ok(reply)
    }
    _ => Err(format!("No endpoint for api/remote/{endpoint}")),
  }
}

#[derive(Deserialize)]
struct RemoteRequest {
  url: String,
  #[serde(default)]
  headers: HashMap<String, String>,
}

const TIMEOUT: Duration = Duration::from_secs(60);
/// The most a catalog page may be.
const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;
/// The most an image read whole may be.
const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// The most a downloaded book may be.
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;

/// A downloaded file's name: the server's (Content-Disposition), else the address's last part.
fn download_name(disposition: Option<&str>, url: &str) -> String {
  let disposition = disposition.unwrap_or("");
  let after = |key: &str| {
    let lower = disposition.to_lowercase();
    lower.find(key).map(|at| disposition[at + key.len()..].split(';').next().unwrap_or("").trim().to_string())
  };
  let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned();
  let star = after("filename*=").and_then(|v| {
    let lower = v.to_lowercase();
    lower.strip_prefix("utf-8''").map(|_| decode(&v[7..]))
  });
  let plain = after("filename=").map(|v| v.trim_matches('"').to_string());
  let from_url = || {
    let path = url.split(['?', '#']).next().unwrap_or("");
    decode(path.rsplit('/').next().unwrap_or(""))
  };
  let name = star.or(plain).filter(|n| !n.is_empty()).unwrap_or_else(from_url);
  let name = name.replace(['/', '\\'], "_").trim().to_string();
  if name.is_empty() { "download".into() } else { name }
}

#[cfg(test)]
mod tests {
  use super::download_name;

  #[test]
  fn names_downloads() {
    assert_eq!(download_name(Some("attachment; filename=\"Dune.epub\""), "https://x/1"), "Dune.epub");
    assert_eq!(download_name(Some("attachment; filename*=UTF-8''Caf%C3%A9.epub"), "https://x/1"), "Café.epub");
    assert_eq!(download_name(None, "https://x/books/Dune%20II.epub?x=1"), "Dune II.epub");
    assert_eq!(download_name(None, "https://x/"), "download");
  }
}
