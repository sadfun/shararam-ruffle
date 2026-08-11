use anyhow::Result;
use sha2::{Digest, Sha256};
use shararam_ruffle::{http_server, state::AppState};
use std::net::Ipv4Addr;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .without_time()
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--verify-official-base") {
        let original = wreq_transport::Client::new()
            .get("https://www.shararam.ru/base.swf")
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        println!(
            "official base.swf  {}  {} bytes",
            hex::encode(Sha256::digest(&original)),
            original.len(),
        );
        return Ok(());
    }
    let requested_port = args
        .windows(2)
        .find(|pair| pair[0] == "--port")
        .and_then(|pair| pair[1].parse::<u16>().ok())
        .unwrap_or(0);
    // Public hosted mode: a TLS-terminating reverse proxy owns this host name
    // and forwards to the loopback listener. The capability reaches browsers
    // through the served page, so no URL is opened.
    let public_host = args
        .windows(2)
        .find(|pair| pair[0] == "--public-host")
        .map(|pair| pair[1].clone())
        .or_else(|| std::env::var("SHARARAM_PUBLIC_HOST").ok())
        .filter(|host| !host.is_empty());

    let state = match &public_host {
        Some(host) => AppState::with_public_host(host.clone())?,
        None => AppState::new()?,
    };
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, requested_port)).await?;
    let address = listener.local_addr()?;
    let capability = state.capability().to_owned();
    let router = http_server::router(state);
    let server = tokio::spawn(async move { axum::serve(listener, router).await });

    if let Some(host) = &public_host {
        println!(
            "Shararam Ruffle (public): https://{host}/  ->  127.0.0.1:{}",
            address.port()
        );
        server.await??;
        return Ok(());
    }

    let url = format!("http://127.0.0.1:{}/?cap={}", address.port(), capability);

    #[cfg(feature = "desktop")]
    if !args.iter().any(|arg| arg == "--serve") {
        return shararam_ruffle::desktop::run(&url, server);
    }

    println!("Shararam Ruffle: {url}");
    if !args.iter().any(|arg| arg == "--no-open") {
        let _ = webbrowser::open(&url);
    }
    server.await??;
    Ok(())
}
