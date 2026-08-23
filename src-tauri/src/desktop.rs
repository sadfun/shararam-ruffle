use crate::profiler::Profiler;
use anyhow::Result;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::task::JoinHandle;

pub fn run(
    url: &str,
    server: JoinHandle<Result<(), std::io::Error>>,
    profiler: Profiler,
) -> Result<()> {
    let window_url = url.parse()?;
    let title = if profiler.enabled() {
        "Шарарам Ruffle (профилирование)"
    } else {
        "Шарарам Ruffle"
    };
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(window_url))
                .title(title)
                .inner_size(1320.0, 820.0)
                .min_inner_size(815.0, 540.0)
                .maximized(true)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(move |_app, event| {
            // Tauri may terminate the process right after this event, so the
            // profile has to be flushed here rather than after `run` returns.
            if let RunEvent::Exit = event {
                profiler.finish();
            }
        });
    server.abort();
    Ok(())
}
