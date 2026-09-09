use anyhow::Result;
use rand::RngCore;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

use crate::auth::{OFFICIAL_ORIGIN, OfficialSession};
use crate::profiler::Profiler;
use serde::Serialize;

#[derive(Clone)]
pub struct AppState {
    capability: Arc<str>,
    official_origin: Arc<str>,
    /// External host when the companion runs as a public server behind a
    /// TLS-terminating reverse proxy (e.g. `shararam.sadfun.dev`). `None` means
    /// the default single-user loopback mode.
    public_host: Option<Arc<str>>,
    pub sessions: Arc<RwLock<HashMap<String, OfficialSession>>>,
    pub official_base: Arc<RwLock<Option<CachedBase>>>,
    pub diagnostics: Arc<RwLock<Diagnostics>>,
    /// Profiling session (a no-op shell unless built with `--features profiler`).
    pub profiler: Profiler,
    /// Persistent disk cache for immutable `/fs/` game assets.
    pub asset_cache: Arc<crate::asset_cache::AssetCache>,
    /// Loopback ports this process listens on: the main one first, then the
    /// asset shards (see `main.rs`). Empty in tests and public mode.
    ports: Arc<[u16]>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub proxy_requests: u64,
    pub websocket_requests: u64,
    pub tunnel_connections: u64,
    pub tunnel_closes: u64,
    pub tunnel_active: bool,
    pub browser_to_tcp_bytes: u64,
    pub tcp_to_browser_bytes: u64,
    pub last_tunnel_error: Option<String>,
    pub server_count: usize,
}

#[derive(Clone)]
pub struct CachedBase {
    pub bytes: Arc<Vec<u8>>,
    pub sha256: String,
    /// base.swf with filters/cacheAsBitmap stripped (see `swf_patch`),
    /// computed once when the original is cached. `None` when patching is
    /// disabled or nothing needed changing.
    pub patched: Option<Arc<Vec<u8>>>,
}

impl AppState {
    pub fn new() -> Result<Self> {
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let capability = hex::encode(random);
        Ok(Self {
            capability: capability.into(),
            official_origin: Arc::from(OFFICIAL_ORIGIN),
            public_host: None,
            sessions: Default::default(),
            official_base: Default::default(),
            diagnostics: Default::default(),
            profiler: Profiler::default(),
            asset_cache: Arc::new(crate::asset_cache::AssetCache::new()),
            ports: Arc::from(Vec::new()),
        })
    }

    /// Records the listener ports: `main` serves the page, `shards` only
    /// ever see `/official/fs/` requests fanned out by the page.
    pub fn with_ports(mut self, main: u16, shards: Vec<u16>) -> Self {
        let mut ports = vec![main];
        ports.extend(shards);
        self.ports = Arc::from(ports);
        self
    }

    /// The shard ports, comma separated, for the served page.
    pub fn asset_ports_csv(&self) -> String {
        self.ports
            .iter()
            .skip(1)
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(",")
    }

    /// Whether `origin` is one of our own loopback listeners (the page on the
    /// main port fetching assets from a shard port is cross-origin).
    pub fn is_own_loopback_origin(&self, origin: &str) -> bool {
        if self.public_host.is_some() {
            return false;
        }
        let Some(rest) = origin.strip_prefix("http://") else {
            return false;
        };
        let Some((host, port)) = rest.rsplit_once(':') else {
            return false;
        };
        (host == "127.0.0.1" || host == "localhost")
            && port.parse::<u16>().is_ok_and(|port| self.ports.contains(&port))
    }

    /// Attaches a profiling session; every route and the socket tunnel
    /// report into it.
    pub fn with_profiler(mut self, profiler: Profiler) -> Self {
        self.profiler = profiler;
        self
    }

    /// Build a state for public hosted mode behind a reverse proxy that
    /// terminates TLS for `host` and forwards to this loopback server.
    pub fn with_public_host(host: impl Into<String>) -> Result<Self> {
        Ok(Self {
            public_host: Some(Arc::from(host.into().as_str())),
            ..Self::new()?
        })
    }

    pub fn capability(&self) -> &str {
        &self.capability
    }

    pub fn official_origin(&self) -> &str {
        &self.official_origin
    }

    /// Point debug builds at a local fake of the official site. Keeping this
    /// unavailable in release builds prevents credentials from ever being
    /// redirected through a runtime option in production.
    #[cfg(debug_assertions)]
    pub fn with_debug_official_origin(mut self, origin: impl Into<String>) -> Self {
        self.official_origin = Arc::from(origin.into());
        self
    }

    pub fn public_host(&self) -> Option<&str> {
        self.public_host.as_deref()
    }

    pub fn is_public(&self) -> bool {
        self.public_host.is_some()
    }
}
