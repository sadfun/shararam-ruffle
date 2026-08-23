//! Persistent on-disk cache for the game's immutable `/fs/` assets.
//!
//! Shararam serves avatar parts, location art and sounds as content-addressed
//! files (`/fs/<xx>/<hash>.swf?<buster>`), each costing 111–263ms of origin
//! latency on first fetch. Entering a crowded location pulls hundreds of them,
//! which is a large share of the characters-appear-one-by-one warmup. The
//! browser's own HTTP cache only helps within a WebView profile and can
//! revalidate; this cache persists across app restarts and serves hits
//! locally with no upstream round-trip.
//!
//! Only full 200 responses to plain GETs are stored, keyed by the hash of
//! `path?query` (the query is a content buster, so it is part of the
//! identity). Original bytes are stored; SWF patching, when enabled, is
//! applied after a hit. `SHARARAM_ASSET_CACHE=0` disables the cache,
//! `SHARARAM_ASSET_CACHE_DIR` overrides the location.

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

/// Refuse to store bodies larger than this (the biggest real asset, the
/// avatar rig, is ~1.3MB).
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Start trimming oldest entries when the directory grows past this…
const TRIM_HIGH_WATER: u64 = 768 * 1024 * 1024;
/// …down to this.
const TRIM_LOW_WATER: u64 = 512 * 1024 * 1024;

pub struct AssetCache {
    dir: Option<PathBuf>,
}

impl Default for AssetCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AssetCache {
    pub fn new() -> Self {
        if matches!(
            std::env::var("SHARARAM_ASSET_CACHE").as_deref(),
            Ok("0") | Ok("false") | Ok("off") | Ok("no")
        ) {
            return Self { dir: None };
        }
        let dir = std::env::var_os("SHARARAM_ASSET_CACHE_DIR")
            .map(PathBuf::from)
            .or_else(default_cache_dir);
        let dir = dir.and_then(|dir| match std::fs::create_dir_all(&dir) {
            Ok(()) => Some(dir),
            Err(error) => {
                tracing::warn!(%error, ?dir, "asset cache disabled: cannot create directory");
                None
            }
        });
        if let Some(dir) = &dir {
            tracing::info!(?dir, "asset cache enabled");
        }
        Self { dir }
    }

    pub fn enabled(&self) -> bool {
        self.dir.is_some()
    }

    fn entry_path(&self, path: &str, query: Option<&str>) -> Option<PathBuf> {
        let dir = self.dir.as_ref()?;
        let mut hasher = Sha256::new();
        hasher.update(path.as_bytes());
        if let Some(query) = query {
            hasher.update(b"?");
            hasher.update(query.as_bytes());
        }
        Some(dir.join(hex::encode(hasher.finalize())))
    }

    /// Returns the cached body and content type, if present.
    pub async fn get(&self, path: &str, query: Option<&str>) -> Option<(Vec<u8>, Option<String>)> {
        let entry = self.entry_path(path, query)?;
        let body = tokio::fs::read(&entry).await.ok()?;
        if body.is_empty() {
            return None;
        }
        let content_type = tokio::fs::read_to_string(entry.with_extension("ct"))
            .await
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Some((body, content_type))
    }

    /// Stores a response body. Failures only log; the cache is best-effort.
    pub async fn put(
        &self,
        path: &str,
        query: Option<&str>,
        content_type: Option<&str>,
        body: &[u8],
    ) {
        if body.is_empty() || body.len() > MAX_BODY_BYTES {
            return;
        }
        let Some(entry) = self.entry_path(path, query) else {
            return;
        };
        let tmp = entry.with_extension("tmp");
        let write = async {
            tokio::fs::write(&tmp, body).await?;
            tokio::fs::rename(&tmp, &entry).await?;
            if let Some(content_type) = content_type {
                tokio::fs::write(entry.with_extension("ct"), content_type).await?;
            }
            std::io::Result::Ok(())
        };
        if let Err(error) = write.await {
            tracing::debug!(%error, path, "asset cache write failed");
            let _ = tokio::fs::remove_file(&tmp).await;
        }
    }

    /// Trims oldest entries when the directory outgrows the high-water mark.
    /// Spawned once at server start; a no-op below the threshold.
    pub fn spawn_trim(self: &Arc<Self>) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let cache = self.clone();
        handle.spawn(async move {
            let Some(dir) = cache.dir.clone() else { return };
            let result = tokio::task::spawn_blocking(move || trim_dir(&dir)).await;
            if let Ok(Err(error)) = result {
                tracing::debug!(%error, "asset cache trim failed");
            }
        });
    }
}

fn default_cache_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join("Library/Caches/shararam-ruffle/assets"))
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(base).join("shararam-ruffle").join("assets"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let base = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
        Some(base.join("shararam-ruffle").join("assets"))
    }
}

fn trim_dir(dir: &std::path::Path) -> std::io::Result<()> {
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total = 0u64;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        entries.push((
            entry.path(),
            meta.len(),
            meta.modified().unwrap_or(std::time::UNIX_EPOCH),
        ));
    }
    if total <= TRIM_HIGH_WATER {
        return Ok(());
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, len, _) in entries {
        if total <= TRIM_LOW_WATER {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    tracing::info!(total, "asset cache trimmed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_in(dir: &std::path::Path) -> AssetCache {
        AssetCache {
            dir: Some(dir.to_path_buf()),
        }
    }

    #[tokio::test]
    async fn roundtrips_body_and_content_type() {
        let dir = std::env::temp_dir().join(format!("shararam-asset-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = cache_in(&dir);
        assert!(cache.get("fs/ab/xyz.swf", Some("123")).await.is_none());
        cache
            .put(
                "fs/ab/xyz.swf",
                Some("123"),
                Some("application/x-shockwave-flash"),
                b"CWS fake",
            )
            .await;
        let (body, content_type) = cache.get("fs/ab/xyz.swf", Some("123")).await.unwrap();
        assert_eq!(body, b"CWS fake");
        assert_eq!(
            content_type.as_deref(),
            Some("application/x-shockwave-flash")
        );
        // The query is part of the identity.
        assert!(cache.get("fs/ab/xyz.swf", Some("456")).await.is_none());
        assert!(cache.get("fs/ab/xyz.swf", None).await.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn oversized_bodies_are_not_stored() {
        let dir =
            std::env::temp_dir().join(format!("shararam-asset-cache-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = cache_in(&dir);
        cache
            .put("fs/big", None, None, &vec![0u8; MAX_BODY_BYTES + 1])
            .await;
        assert!(cache.get("fs/big", None).await.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
