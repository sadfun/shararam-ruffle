use anyhow::Result;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tokio::task::JoinHandle;

pub fn run(url: &str, server: JoinHandle<Result<(), std::io::Error>>) -> Result<()> {
    let window_url = url.parse()?;
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(window_url))
                .title("Шарарам Ruffle")
                .inner_size(1320.0, 820.0)
                .min_inner_size(815.0, 540.0)
                .maximized(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())?;
    server.abort();
    Ok(())
}
