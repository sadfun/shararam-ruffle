use anyhow::{Context, Result, bail};
use axum::extract::ws::{Message, WebSocket};
use futures_util::SinkExt;
use serde::Deserialize;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::RwLock,
};
use url::Url;

use crate::profiler::{self, Profiler};
use crate::state::Diagnostics;

const BUFFER_SIZE: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub struct TunnelQuery {
    pub cap: String,
    pub host: String,
    pub port: u16,
}

pub fn endpoint_target(endpoint: &str) -> Result<(String, u16)> {
    let url = Url::parse(endpoint).context("invalid official socket endpoint")?;
    if url.scheme() != "rtmp" {
        bail!("official socket endpoint has an unsupported scheme");
    }
    let host = url
        .host_str()
        .context("official socket endpoint has no host")?
        .to_owned();
    Ok((host, url.port().unwrap_or(1935)))
}

pub async fn run(
    mut websocket: WebSocket,
    endpoint: String,
    diagnostics: Arc<RwLock<Diagnostics>>,
    profiler: Profiler,
) {
    {
        let mut diagnostics = diagnostics.write().await;
        diagnostics.tunnel_connections += 1;
        diagnostics.tunnel_active = true;
        diagnostics.last_tunnel_error = None;
    }
    let opened = profiler::now_us();
    profiler.event(
        "socket",
        "tunnel_open",
        opened,
        0,
        Some(format!("{{\"endpoint\":{}}}", serde_json::json!(endpoint))),
    );

    let mut counts = ByteCounts::default();
    let result = copy(&mut websocket, &endpoint, &mut counts, &profiler).await;
    profiler.event(
        "socket",
        "tunnel_close",
        opened,
        profiler::now_us() - opened,
        Some(
            serde_json::json!({
                "endpoint": endpoint,
                "browser_to_tcp": counts.browser_to_tcp,
                "tcp_to_browser": counts.tcp_to_browser,
                "error": result.as_ref().err().map(|error| error.to_string()),
            })
            .to_string(),
        ),
    );
    {
        let mut diagnostics = diagnostics.write().await;
        diagnostics.tunnel_closes += 1;
        diagnostics.tunnel_active = false;
        diagnostics.browser_to_tcp_bytes += counts.browser_to_tcp;
        diagnostics.tcp_to_browser_bytes += counts.tcp_to_browser;
        if let Err(error) = &result {
            diagnostics.last_tunnel_error = Some(error.to_string());
        }
    }
    if let Err(error) = result {
        tracing::warn!("opaque socket tunnel ended: {error}");
    }
    let _ = websocket.close().await;
}

async fn copy(
    websocket: &mut WebSocket,
    endpoint: &str,
    counts: &mut ByteCounts,
    profiler: &Profiler,
) -> Result<()> {
    let (host, port) = endpoint_target(endpoint)?;
    let connect_started = profiler::now_us();
    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .with_context(|| format!("could not connect to approved socket endpoint {host}:{port}"))?;
    profiler.event(
        "socket",
        "tcp_connect",
        connect_started,
        profiler::now_us() - connect_started,
        Some(format!(
            "{{\"host\":{},\"port\":{port}}}",
            serde_json::json!(host)
        )),
    );
    tcp.set_nodelay(true)?;
    let (mut tcp_reader, mut tcp_writer) = tcp.into_split();
    let mut buffer = vec![0; BUFFER_SIZE];
    // Throughput samples once a second, so the viewer can show traffic
    // volume next to the RPC events.
    let mut sample_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let mut sampled = ByteCounts::default();

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(sample_deadline), if profiler.enabled() => {
                profiler.sample("tunnel_up_bytes", (counts.browser_to_tcp - sampled.browser_to_tcp) as f64);
                profiler.sample("tunnel_down_bytes", (counts.tcp_to_browser - sampled.tcp_to_browser) as f64);
                sampled = ByteCounts { browser_to_tcp: counts.browser_to_tcp, tcp_to_browser: counts.tcp_to_browser };
                sample_deadline += std::time::Duration::from_secs(1);
            }
            incoming = websocket.recv() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        tcp_writer.write_all(&bytes).await?;
                        counts.browser_to_tcp += bytes.len() as u64;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        tcp_writer.shutdown().await?;
                        return Ok(());
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        websocket.send(Message::Pong(payload)).await?;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Text(_))) => {
                        bail!("opaque socket tunnel accepts binary WebSocket messages only");
                    }
                    Some(Err(error)) => return Err(error.into()),
                }
            }
            read = tcp_reader.read(&mut buffer) => {
                let count = read?;
                if count == 0 {
                    return Ok(());
                }
                websocket
                    .send(Message::Binary(buffer[..count].to_vec().into()))
                    .await?;
                counts.tcp_to_browser += count as u64;
            }
        }
    }
}

#[derive(Default)]
struct ByteCounts {
    browser_to_tcp: u64,
    tcp_to_browser: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_socket_endpoints() {
        assert_eq!(
            endpoint_target("rtmp://game.example.test/world").unwrap(),
            ("game.example.test".to_owned(), 1935)
        );
        assert_eq!(
            endpoint_target("rtmp://game.example.test:8443/world").unwrap(),
            ("game.example.test".to_owned(), 8443)
        );
        assert!(endpoint_target("https://game.example.test/world").is_err());
        assert!(endpoint_target("not a URL").is_err());
    }

    #[test]
    fn transport_module_has_no_application_codec() {
        let source = include_str!("tunnel.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .to_ascii_lowercase();
        for forbidden in [
            "flash_lso",
            "amf0",
            "transaction_id",
            "responder",
            "heartbeat",
            "\"_result\"",
            "\"_error\"",
            "netconnection",
        ] {
            assert!(
                !source.contains(forbidden),
                "forbidden token in tunnel: {forbidden}"
            );
        }
    }
}
