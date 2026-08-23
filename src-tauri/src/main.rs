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
    // Profiling build: one DuckDB file per run. `--profile-dir <dir>` or
    // SHARARAM_PROFILE_DIR chooses where; the default is ./profiles.
    let profiler = if cfg!(feature = "profiler") {
        let directory = args
            .windows(2)
            .find(|pair| pair[0] == "--profile-dir")
            .map(|pair| std::path::PathBuf::from(&pair[1]))
            .or_else(|| std::env::var_os("SHARARAM_PROFILE_DIR").map(Into::into));
        let profiler = shararam_ruffle::profiler::Profiler::start(directory)?;
        if let Some(path) = profiler.path() {
            println!("Profiling to {}", path.display());
        }
        profiler
    } else {
        shararam_ruffle::profiler::Profiler::default()
    };
    let state = state.with_profiler(profiler.clone());
    #[cfg(debug_assertions)]
    let state = match std::env::var("SHARARAM_E2E_OFFICIAL_ORIGIN") {
        Ok(origin) if !origin.is_empty() => {
            tracing::warn!(%origin, "debug build uses the local e2e official origin");
            state.with_debug_official_origin(origin)
        }
        _ => state,
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
        // Ctrl-C / SIGTERM cannot reach the Tauri run loop, so flush the
        // profile here and exit; normal window close goes through
        // `RunEvent::Exit` inside `desktop::run`.
        let signal_profiler = profiler.clone();
        tokio::spawn(async move {
            shutdown_signal().await;
            signal_profiler.finish();
            std::process::exit(0);
        });
        let result = shararam_ruffle::desktop::run(&url, server, profiler.clone());
        profiler.finish();
        return result;
    }

    println!("Shararam Ruffle: {url}");
    if !args.iter().any(|arg| arg == "--no-open") {
        let _ = webbrowser::open(&url);
    }
    // Ctrl-C or SIGTERM ends a `--serve` session; the profiling build
    // finalises the profile file before exiting.
    tokio::select! {
        result = server => result??,
        _ = shutdown_signal() => {
            println!("Shutting down");
        }
    }
    profiler.finish();
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(term) => term,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
