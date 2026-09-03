use anyhow::{Context, Result, ensure};
use axum::http::uri::Authority;
use rand::RngCore;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

use crate::auth::{OFFICIAL_ORIGIN, OfficialSession};
use serde::Serialize;

#[derive(Clone)]
pub struct AppState {
    capability: Arc<str>,
    official_origin: Arc<str>,
    /// External host when the companion runs as a public server behind a
    /// TLS-terminating reverse proxy (e.g. `shararam.sadfun.dev`). `None` means
    /// the default single-user loopback mode.
    public_host: Option<Authority>,
    pub sessions: Arc<RwLock<HashMap<String, OfficialSession>>>,
    pub(crate) session_usernames: Arc<RwLock<HashMap<String, Arc<str>>>>,
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
            official_origin: Arc::from(OFFICIAL_ORIGIN),
            public_host: None,
            sessions: Default::default(),
            session_usernames: Default::default(),
            official_base: Default::default(),
            diagnostics: Default::default(),
        })
    }

    /// Build a state for public hosted mode behind a reverse proxy that
    /// terminates TLS for `host` and forwards to this loopback server.
    pub fn with_public_host(host: impl Into<String>) -> Result<Self> {
        let host = host.into();
        ensure!(
            !host.contains('@'),
            "public host must not contain user information"
        );
        let public_host = host.parse::<Authority>().with_context(|| {
            format!("invalid public host {host:?}; expected a host name with an optional port")
        })?;
        ensure!(
            public_host
                .as_str()
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')),
            "public host contains characters that are unsafe in a CSP source"
        );
        Ok(Self {
            public_host: Some(public_host),
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
        self.public_host.as_ref().map(Authority::as_str)
    }

    pub fn is_public(&self) -> bool {
        self.public_host.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_host_requires_an_http_authority() {
        let state = AppState::with_public_host("Example.COM:8443").unwrap();
        assert_eq!(state.public_host(), Some("Example.COM:8443"));

        for invalid in [
            "",
            "https://example.com",
            "example.com/path",
            "user@example.com",
            "example.com;script-src",
            "example.com,script-src",
            "example.com'",
            "example.com\r\nx-injected: true",
        ] {
            assert!(
                AppState::with_public_host(invalid).is_err(),
                "accepted invalid public host {invalid:?}"
            );
        }
    }
}
