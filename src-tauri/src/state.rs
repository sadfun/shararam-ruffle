use anyhow::Result;
use rand::RngCore;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

use crate::auth::OfficialSession;
use serde::Serialize;

#[derive(Clone)]
pub struct AppState {
    capability: Arc<str>,
    /// External host when the companion runs as a public server behind a
    /// TLS-terminating reverse proxy (e.g. `shararam.sadfun.dev`). `None` means
    /// the default single-user loopback mode.
    public_host: Option<Arc<str>>,
    pub sessions: Arc<RwLock<HashMap<String, OfficialSession>>>,
    pub official_base: Arc<RwLock<Option<CachedBase>>>,
    pub diagnostics: Arc<RwLock<Diagnostics>>,
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
}

impl AppState {
    pub fn new() -> Result<Self> {
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let capability = hex::encode(random);
        Ok(Self {
            capability: capability.into(),
            public_host: None,
            sessions: Default::default(),
            official_base: Default::default(),
            diagnostics: Default::default(),
        })
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

    pub fn public_host(&self) -> Option<&str> {
        self.public_host.as_deref()
    }

    pub fn is_public(&self) -> bool {
        self.public_host.is_some()
    }
}
