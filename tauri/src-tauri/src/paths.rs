use std::path::{Path, PathBuf};

/// The file for a library path (slash-separated, relative to `root`, which must be a real path),
/// refusing anything that would leave `root`: `..`, absolute paths, and symlinks pointing out.
/// As `resolveLibraryPath` in `desktop/src/fileStorage.ts`.
pub fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
  let bad = || format!("Bad path: {path}");
  if path.is_empty() {
    return Err(bad());
  }
  let mut file = root.to_path_buf();
  for segment in path.split('/') {
    if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\') || segment.contains('\0') {
      return Err(bad());
    }
    file.push(segment);
  }
  // The deepest part of the path that exists must stay inside, symlinks resolved.
  let mut existing = file.as_path();
  let real = loop {
    if let Ok(real) = existing.canonicalize() {
      break real;
    }
    match existing.parent() {
      Some(parent) => existing = parent,
      None => return Err(bad()),
    }
  };
  if !real.starts_with(root) {
    return Err(bad());
  }
  Ok(file)
}

/// A folder's real path, made if it isn't there.
pub fn real_dir(dir: &Path) -> Result<PathBuf, String> {
  std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  dir.canonicalize().map_err(|e| e.to_string())
}

/// Where a library folder keeps nexlibris's own files: its `.nexlibris/` when it's laid out
/// (a folder of the user's, `common/src/placedLibrary.ts`), else the folder itself.
pub fn data_dir(dir: &Path) -> PathBuf {
  if is_placed(dir) {
    dir.join(".nexlibris")
  } else {
    dir.to_path_buf()
  }
}

pub fn is_placed(dir: &Path) -> bool {
  dir.join(".nexlibris").join("layout.json").is_file()
}

/// Whether the page may fetch a library path from `/library/…`: `servedLibraryPath` in common.
pub fn served(path: &str, placed: bool) -> bool {
  const DATA_PREFIX: &str = ".nexlibris/";
  if placed && !path.starts_with(DATA_PREFIX) {
    return !path.starts_with('.') && !path.contains("/.");
  }
  let inner = if placed { &path[DATA_PREFIX.len()..] } else { path };
  inner.starts_with("files/") || inner.starts_with("local/thumbs/")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn refuses_paths_out_of_the_library() {
    let root = real_dir(&std::env::temp_dir().join("nexlibris-paths-test")).unwrap();
    assert!(resolve(&root, "files/ab/abc").is_ok());
    for bad in ["", "/etc", "../x", "a//b", "a/./b", "a\\b", "a/../../b"] {
      assert!(resolve(&root, bad).is_err(), "{bad}");
    }
  }

  #[test]
  fn serves_only_files_and_thumbnails() {
    assert!(served("files/ab/abc", false));
    assert!(served("local/thumbs/x.jpg", false));
    assert!(!served("library.json", false));
    assert!(served("Frank Herbert/Dune.epub", true));
    assert!(!served(".nexlibris/library.json", true));
    assert!(served(".nexlibris/files/ab/abc", true));
    assert!(!served("a/.hidden", true));
  }
}
