//! Profiling session storage for the `profiler` build.
//!
//! A profiling build of Shararam Ruffle records everything the client does
//! over time into one DuckDB file: frame timings and browser performance
//! entries from the page, Ruffle's own events (the `shararam_profiler`
//! feature of the Ruffle fork), and the local server's proxy / tunnel
//! activity. The file is created when the server starts and finalised when
//! the desktop window closes (or on Ctrl-C in `--serve` mode).
//!
//! All timestamps are microseconds since the Unix epoch. The page converts
//! `performance.now()` values with `performance.timeOrigin`, the server uses
//! `SystemTime`, so every source lands on one common timeline.
//!
//! Without the `profiler` cargo feature this module is an empty shell: every
//! method is a no-op and `Profiler` carries no data.

pub use imp::Profiler;

/// One event to store. `args` is a JSON object as text.
#[derive(Debug)]
pub struct Event {
    pub ts_us: i64,
    pub dur_us: i64,
    pub source: &'static str,
    pub cat: String,
    pub name: String,
    pub args: Option<String>,
}

pub fn now_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[cfg(feature = "profiler")]
mod imp {
    use super::{Event, now_us};
    use anyhow::{Context, Result};
    use duckdb::{Connection, params};
    use serde::Deserialize;
    use serde_json::value::RawValue;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5);

    enum Message {
        Events(Vec<Event>),
        Frames(Vec<(i64, f64)>),
        Samples(Vec<(i64, String, f64)>),
        Meta(String, String),
        Finish(Sender<()>),
    }

    struct Inner {
        path: PathBuf,
        sender: Mutex<Option<Sender<Message>>>,
        writer: Mutex<Option<JoinHandle<()>>>,
        started_us: i64,
    }

    /// Handle to the profiling session; cheap to clone, shared by the HTTP
    /// routes, the tunnel, and the desktop shell.
    #[derive(Clone, Default)]
    pub struct Profiler {
        inner: Option<Arc<Inner>>,
    }

    impl Profiler {
        /// Creates `shararam-profile-<timestamp>.duckdb` in `directory`
        /// (default: `profiles/` under the current directory) and starts the
        /// writer thread.
        pub fn start(directory: Option<PathBuf>) -> Result<Self> {
            let directory = directory.unwrap_or_else(|| PathBuf::from("profiles"));
            std::fs::create_dir_all(&directory)
                .with_context(|| format!("cannot create {}", directory.display()))?;
            let stamp = chrono_like_stamp();
            let path = directory.join(format!("shararam-profile-{stamp}.duckdb"));
            let connection = Connection::open(&path)
                .with_context(|| format!("cannot create {}", path.display()))?;
            create_schema(&connection)?;

            let (sender, receiver) = mpsc::channel::<Message>();
            let writer_path = path.clone();
            let writer = std::thread::Builder::new()
                .name("profiler-writer".into())
                .spawn(move || writer_loop(connection, receiver, writer_path))
                .context("cannot start profiler writer thread")?;

            let profiler = Self {
                inner: Some(Arc::new(Inner {
                    path,
                    sender: Mutex::new(Some(sender)),
                    writer: Mutex::new(Some(writer)),
                    started_us: now_us(),
                })),
            };
            profiler.meta(
                "started_us",
                &profiler.inner.as_ref().unwrap().started_us.to_string(),
            );
            profiler.meta("client_version", env!("CARGO_PKG_VERSION"));
            profiler.meta("platform", std::env::consts::OS);
            profiler.meta("arch", std::env::consts::ARCH);
            profiler.event(
                "server",
                "session_start",
                now_us(),
                0,
                Some(format!(
                    "{{\"version\":\"{}\",\"platform\":\"{}\"}}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS
                )),
            );
            Ok(profiler)
        }

        pub fn enabled(&self) -> bool {
            self.inner.is_some()
        }

        pub fn path(&self) -> Option<&Path> {
            self.inner.as_ref().map(|inner| inner.path.as_path())
        }

        fn send(&self, message: Message) {
            if let Some(inner) = &self.inner
                && let Ok(guard) = inner.sender.lock()
                && let Some(sender) = guard.as_ref()
            {
                let _ = sender.send(message);
            }
        }

        pub fn meta(&self, key: &str, value: &str) {
            self.send(Message::Meta(key.to_string(), value.to_string()));
        }

        /// Records one server-side event. `args` is a JSON object as text.
        pub fn event(
            &self,
            cat: &'static str,
            name: &'static str,
            ts_us: i64,
            dur_us: i64,
            args: Option<String>,
        ) {
            if !self.enabled() {
                return;
            }
            self.send(Message::Events(vec![Event {
                ts_us,
                dur_us,
                source: "server",
                cat: cat.to_string(),
                name: name.to_string(),
                args,
            }]));
        }

        pub fn sample(&self, name: &str, value: f64) {
            if !self.enabled() {
                return;
            }
            self.send(Message::Samples(vec![(now_us(), name.to_string(), value)]));
        }

        /// Stores a batch posted by the page. Returns the number of stored
        /// rows. See `web/profiler.js` for the format.
        pub fn ingest_browser_batch(&self, body: &[u8]) -> Result<usize> {
            if !self.enabled() {
                return Ok(0);
            }
            let batch: BrowserBatch = serde_json::from_slice(body).context("malformed batch")?;
            let origin = batch.origin_us;
            let to_us = |ms: f64| origin + (ms * 1000.0).round() as i64;
            let mut events = Vec::new();
            if let Some(ruffle) = batch.ruffle.as_deref() {
                let ruffle: Vec<RawEvent> =
                    serde_json::from_str(ruffle).context("malformed ruffle events")?;
                events.extend(ruffle.into_iter().map(|event| Event {
                    ts_us: to_us(event.t),
                    dur_us: (event.d * 1000.0).round() as i64,
                    source: "ruffle",
                    cat: event.c,
                    name: event.n,
                    args: event.a.map(|raw| raw.get().to_string()),
                }));
            }
            events.extend(batch.events.into_iter().map(|event| Event {
                ts_us: to_us(event.t),
                dur_us: (event.d * 1000.0).round() as i64,
                source: "browser",
                cat: event.c,
                name: event.n,
                args: event.a.map(|raw| raw.get().to_string()),
            }));
            let frames: Vec<(i64, f64)> = batch
                .frames
                .into_iter()
                .map(|(t, dt)| (to_us(t), dt))
                .collect();
            let samples: Vec<(i64, String, f64)> = batch
                .samples
                .into_iter()
                .map(|(t, name, value)| (to_us(t), name, value))
                .collect();
            let count = events.len() + frames.len() + samples.len();
            if !events.is_empty() {
                self.send(Message::Events(events));
            }
            if !frames.is_empty() {
                self.send(Message::Frames(frames));
            }
            if !samples.is_empty() {
                self.send(Message::Samples(samples));
            }
            for (key, value) in batch.meta {
                self.meta(&key, &value);
            }
            Ok(count)
        }

        /// Flushes everything, checkpoints, and closes the file. Safe to call
        /// more than once; later calls are no-ops.
        pub fn finish(&self) {
            let Some(inner) = &self.inner else {
                return;
            };
            self.event("server", "session_end", now_us(), 0, None);
            let sender = inner.sender.lock().ok().and_then(|mut guard| guard.take());
            if let Some(sender) = sender {
                let (done, finished) = mpsc::channel();
                let _ = sender.send(Message::Finish(done));
                drop(sender);
                let _ = finished.recv_timeout(Duration::from_secs(30));
            }
            if let Some(writer) = inner.writer.lock().ok().and_then(|mut guard| guard.take()) {
                let _ = writer.join();
            }
            tracing::info!(path = %inner.path.display(), "profile written");
            println!("Profile written: {}", inner.path.display());
        }
    }

    #[derive(Deserialize)]
    struct RawEvent<'a> {
        t: f64,
        #[serde(default)]
        d: f64,
        c: String,
        n: String,
        #[serde(borrow, default)]
        a: Option<&'a RawValue>,
    }

    #[derive(Deserialize)]
    struct BrowserBatch<'a> {
        #[serde(rename = "originUs")]
        origin_us: i64,
        #[serde(default)]
        ruffle: Option<String>,
        #[serde(borrow, default)]
        events: Vec<RawEvent<'a>>,
        #[serde(default)]
        frames: Vec<(f64, f64)>,
        #[serde(default)]
        samples: Vec<(f64, String, f64)>,
        #[serde(default)]
        meta: Vec<(String, String)>,
    }

    fn chrono_like_stamp() -> String {
        // `YYYYMMDD-HHMMSS` in UTC without pulling in chrono.
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let days = secs / 86_400;
        let rem = secs % 86_400;
        let (hours, minutes, seconds) = (rem / 3600, (rem % 3600) / 60, rem % 60);
        // Civil-from-days (Howard Hinnant's algorithm).
        let z = days as i64 + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{y:04}{m:02}{d:02}-{hours:02}{minutes:02}{seconds:02}")
    }

    fn create_schema(connection: &Connection) -> Result<()> {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS meta(key VARCHAR, value VARCHAR);
                 CREATE TABLE IF NOT EXISTS events(
                     seq BIGINT, ts_us BIGINT, dur_us BIGINT,
                     source VARCHAR, cat VARCHAR, name VARCHAR, args VARCHAR);
                 CREATE TABLE IF NOT EXISTS frames(ts_us BIGINT, dt_ms DOUBLE);
                 CREATE TABLE IF NOT EXISTS samples(ts_us BIGINT, name VARCHAR, value DOUBLE);",
            )
            .context("cannot create profile schema")?;
        Ok(())
    }

    fn create_views(connection: &Connection) -> Result<()> {
        connection
            .execute_batch(
                "CREATE OR REPLACE VIEW rtmp AS
                    SELECT seq, ts_us, name AS direction,
                           json_extract_string(args, '$.method') AS method,
                           CAST(json_extract(args, '$.tid') AS BIGINT) AS tid,
                           json_extract_string(args, '$.kind') AS kind,
                           json_extract(args, '$.args') AS arguments,
                           json_extract(args, '$.command_object') AS command_object
                    FROM events WHERE source = 'ruffle' AND cat = 'rtmp' AND name IN ('send', 'recv');
                 CREATE OR REPLACE VIEW rtmp_calls AS
                    SELECT c.tid, c.method, c.ts_us AS call_ts_us, r.ts_us AS reply_ts_us,
                           (r.ts_us - c.ts_us) / 1000.0 AS latency_ms,
                           r.direction IS NOT NULL AS answered,
                           c.arguments AS call_args, r.arguments AS reply_args
                    FROM rtmp c LEFT JOIN rtmp r
                      ON r.tid = c.tid AND r.direction = 'recv' AND r.kind IN ('result', 'error')
                         AND r.ts_us >= c.ts_us
                    WHERE c.direction = 'send' AND c.kind = 'call';
                 CREATE OR REPLACE VIEW loads AS
                    SELECT seq, ts_us, dur_us / 1000.0 AS ms, name,
                           CAST(json_extract(args, '$.loader') AS BIGINT) AS loader,
                           json_extract_string(args, '$.url') AS url, args
                    FROM events WHERE source = 'ruffle' AND cat = 'load';
                 CREATE OR REPLACE VIEW fps_1s AS
                    SELECT (ts_us // 1000000) * 1000000 AS bucket_us,
                           count(*) AS frames,
                           1000.0 / avg(dt_ms) AS fps_avg,
                           1000.0 / max(dt_ms) AS fps_worst,
                           max(dt_ms) AS worst_frame_ms
                    FROM frames GROUP BY 1 ORDER BY 1;
                 CREATE OR REPLACE VIEW slow_events AS
                    SELECT seq, ts_us, dur_us / 1000.0 AS ms, source, cat, name, args
                    FROM events WHERE dur_us >= 8000 ORDER BY dur_us DESC;",
            )
            .context("cannot create profile views")?;
        Ok(())
    }

    fn writer_loop(connection: Connection, receiver: mpsc::Receiver<Message>, path: PathBuf) {
        let mut next_seq: i64 = 0;
        let mut last_checkpoint = Instant::now();
        let mut dirty = false;
        loop {
            let message = match receiver.recv_timeout(CHECKPOINT_INTERVAL) {
                Ok(message) => Some(message),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let result: Result<()> = match message {
                Some(Message::Events(events)) => (|| {
                    let mut appender = connection.appender("events")?;
                    for event in events {
                        appender.append_row(params![
                            next_seq,
                            event.ts_us,
                            event.dur_us,
                            event.source,
                            event.cat,
                            event.name,
                            event.args,
                        ])?;
                        next_seq += 1;
                    }
                    appender.flush()?;
                    dirty = true;
                    Ok(())
                })(),
                Some(Message::Frames(frames)) => (|| {
                    let mut appender = connection.appender("frames")?;
                    for (ts_us, dt_ms) in frames {
                        appender.append_row(params![ts_us, dt_ms])?;
                    }
                    appender.flush()?;
                    dirty = true;
                    Ok(())
                })(),
                Some(Message::Samples(samples)) => (|| {
                    let mut appender = connection.appender("samples")?;
                    for (ts_us, name, value) in samples {
                        appender.append_row(params![ts_us, name, value])?;
                    }
                    appender.flush()?;
                    dirty = true;
                    Ok(())
                })(),
                Some(Message::Meta(key, value)) => connection
                    .execute("INSERT INTO meta VALUES (?, ?)", params![key, value])
                    .map(|_| ())
                    .map_err(Into::into),
                Some(Message::Finish(done)) => {
                    if let Err(error) = create_views(&connection) {
                        tracing::warn!(%error, "profile views");
                    }
                    if let Err(error) = connection.execute_batch("CHECKPOINT;") {
                        tracing::warn!(%error, "profile checkpoint");
                    }
                    let _ = done.send(());
                    break;
                }
                None => Ok(()),
            };
            if let Err(error) = result {
                tracing::warn!(%error, path = %path.display(), "profile write failed");
            }
            if dirty && last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL {
                // Keep the write-ahead log small so that a file from a
                // session that was killed is still readable by the viewer.
                if let Err(error) = connection.execute_batch("CHECKPOINT;") {
                    tracing::warn!(%error, "profile checkpoint");
                }
                last_checkpoint = Instant::now();
                dirty = false;
            }
        }
        let _ = connection.close();
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn browser_batches_land_on_the_epoch_timeline() {
            let directory =
                std::env::temp_dir().join(format!("shararam-profiler-test-{}", std::process::id()));
            let profiler = Profiler::start(Some(directory.clone())).unwrap();
            let path = profiler.path().unwrap().to_path_buf();
            let batch = serde_json::json!({
                "originUs": 1_700_000_000_000_000i64,
                "ruffle": "[{\"s\":0,\"t\":10.5,\"d\":2.25,\"c\":\"frame\",\"n\":\"tick\",\"a\":{\"dt\":16}},{\"s\":1,\"t\":12,\"d\":0,\"c\":\"rtmp\",\"n\":\"send\"}]",
                "events": [{"t": 20.0, "d": 55.0, "c": "browser", "n": "longtask", "a": {"x": 1}}],
                "frames": [[16.7, 16.7], [33.4, 16.7]],
                "samples": [[50.0, "js_heap", 12345.0]],
                "meta": [["user_agent", "test"]]
            });
            let stored = profiler
                .ingest_browser_batch(batch.to_string().as_bytes())
                .unwrap();
            assert_eq!(stored, 6);
            profiler.event(
                "http",
                "proxy",
                1_700_000_000_100_000,
                2_000,
                Some("{\"path\":\"a\"}".into()),
            );
            profiler.finish();

            let connection = Connection::open(&path).unwrap();
            let events: i64 = connection
                .query_row("SELECT count(*) FROM events", [], |row| row.get(0))
                .unwrap();
            // 2 ruffle + 1 browser + 1 server + session_start + session_end
            assert_eq!(events, 6);
            let (ts, dur, args): (i64, i64, String) = connection
                .query_row(
                    "SELECT ts_us, dur_us, args FROM events WHERE source = 'ruffle' AND name = 'tick'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(ts, 1_700_000_000_010_500);
            assert_eq!(dur, 2_250);
            assert_eq!(args, "{\"dt\":16}");
            let frames: i64 = connection
                .query_row("SELECT count(*) FROM frames", [], |row| row.get(0))
                .unwrap();
            assert_eq!(frames, 2);
            let fps: f64 = connection
                .query_row("SELECT fps_avg FROM fps_1s", [], |row| row.get(0))
                .unwrap();
            assert!((fps - 59.88).abs() < 0.1, "{fps}");
            let meta: String = connection
                .query_row(
                    "SELECT value FROM meta WHERE key = 'user_agent'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(meta, "test");
            drop(connection);
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

#[cfg(not(feature = "profiler"))]
mod imp {
    use super::Event;
    use std::path::{Path, PathBuf};

    /// No-op stand-in: the regular build records nothing.
    #[derive(Clone, Default)]
    pub struct Profiler {
        _private: (),
    }

    #[allow(dead_code)]
    impl Profiler {
        pub fn start(_directory: Option<PathBuf>) -> anyhow::Result<Self> {
            Ok(Self::default())
        }
        #[inline(always)]
        pub fn enabled(&self) -> bool {
            false
        }
        #[inline(always)]
        pub fn path(&self) -> Option<&Path> {
            None
        }
        #[inline(always)]
        pub fn meta(&self, _key: &str, _value: &str) {}
        #[inline(always)]
        pub fn event(
            &self,
            _cat: &'static str,
            _name: &'static str,
            _ts_us: i64,
            _dur_us: i64,
            _args: Option<String>,
        ) {
        }
        #[inline(always)]
        pub fn sample(&self, _name: &str, _value: f64) {}
        #[inline(always)]
        pub fn ingest_browser_batch(&self, _body: &[u8]) -> anyhow::Result<usize> {
            Ok(0)
        }
        #[inline(always)]
        pub fn finish(&self) {}
        #[inline(always)]
        pub fn events(&self, _events: Vec<Event>) {}
    }
}
