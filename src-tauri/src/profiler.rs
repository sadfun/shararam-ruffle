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
#[cfg(feature = "profiler")]
pub use imp::spawn_webcontent_sampler;
#[cfg(not(feature = "profiler"))]
pub fn spawn_webcontent_sampler(_profiler: Profiler) {}

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
        Snapshot(i64, String, Vec<u8>),
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
            cpu::spawn_sampler(profiler.clone());
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

        /// Stores one screen-recording frame (a small JPEG posted by the
        /// page when `?rec=` is on). The viewer shows these as a filmstrip
        /// preview next to the timeline.
        pub fn snapshot(&self, ts_us: i64, mime: &str, bytes: Vec<u8>) {
            if !self.enabled() {
                return;
            }
            self.send(Message::Snapshot(ts_us, mime.to_string(), bytes));
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

    /// Per-process CPU gauges (macOS). A WKWebView splits the page across
    /// helper processes — "com.apple.WebKit.WebContent" runs the page + wasm,
    /// "com.apple.WebKit.GPU" runs its GPU work — so sampling their CPU next
    /// to our own tells whether a main-thread stall was busy uninstrumented
    /// work (WebContent hot) or waiting on the compositor/GPU (WebContent
    /// cold, GPU hot). Written as `samples` rows every 500 ms:
    /// `cpu_client_pct` / `cpu_webcontent_pct` / `cpu_gpu_pct`, percent of
    /// one core (multithreaded processes can exceed 100).
    #[cfg(target_os = "macos")]
    mod cpu {
        use super::Profiler;
        use std::time::{Duration, Instant};

        const SAMPLE_EVERY: Duration = Duration::from_millis(500);
        /// Helper processes restart; re-discover pids every N samples.
        const RESCAN_EVERY: u32 = 4;
        const PROC_ALL_PIDS: u32 = 1;
        const PATH_MAX: usize = 4096;

        pub fn spawn_sampler(profiler: Profiler) {
            let _ = std::thread::Builder::new()
                .name("profiler-cpu".into())
                .spawn(move || run(profiler));
        }

        struct Tracked {
            pid: i32,
            name: &'static str,
            last_ns: u64,
        }

        fn run(profiler: Profiler) {
            let own = std::process::id() as i32;
            let ns_per_tick = ns_per_tick();
            let mut tracked: Vec<Tracked> = Vec::new();
            let mut tick = 0u32;
            let mut last_wall = Instant::now();
            loop {
                std::thread::sleep(SAMPLE_EVERY);
                if tick % RESCAN_EVERY == 0 {
                    tracked = discover(own, &tracked);
                }
                tick = tick.wrapping_add(1);
                let wall = Instant::now();
                let elapsed = wall.duration_since(last_wall).as_secs_f64();
                last_wall = wall;
                if elapsed <= 0.0 {
                    continue;
                }
                let mut by_name: std::collections::HashMap<&'static str, f64> =
                    std::collections::HashMap::new();
                for entry in &mut tracked {
                    let Some(ns) = cpu_time_ns(entry.pid, ns_per_tick) else {
                        continue;
                    };
                    if entry.last_ns > 0 && ns >= entry.last_ns {
                        let pct = (ns - entry.last_ns) as f64 / 1e9 / elapsed * 100.0;
                        *by_name.entry(entry.name).or_default() += pct;
                    }
                    entry.last_ns = ns;
                }
                for (name, pct) in by_name {
                    profiler.sample(name, (pct * 10.0).round() / 10.0);
                }
            }
        }

        /// Our own process plus OUR WebKit helper processes. The helpers are
        /// XPC services parented to launchd, so parent pid is useless; what
        /// they do share with the app is its resource coalition (that is how
        /// Activity Monitor groups them), so match by coalition id — this
        /// also keeps Safari's own helpers out.
        fn discover(own: i32, previous: &[Tracked]) -> Vec<Tracked> {
            let carry = |pid: i32, name: &'static str| Tracked {
                pid,
                name,
                last_ns: previous
                    .iter()
                    .find(|t| t.pid == pid && t.name == name)
                    .map(|t| t.last_ns)
                    .unwrap_or(0),
            };
            let mut out = vec![carry(own, "cpu_client_pct")];
            let own_coalition = coalition_id(own);
            for pid in all_pids() {
                if pid <= 0 || pid == own {
                    continue;
                }
                let Some(path) = pid_path(pid) else { continue };
                let name = if path.contains("com.apple.WebKit.WebContent") {
                    "cpu_webcontent_pct"
                } else if path.contains("com.apple.WebKit.GPU") {
                    "cpu_gpu_pct"
                } else {
                    continue;
                };
                if own_coalition.is_some() && coalition_id(pid) == own_coalition {
                    out.push(carry(pid, name));
                }
            }
            out
        }

        const PROC_PIDCOALITIONINFO: libc::c_int = 20;

        /// proc_pidcoalitioninfo from libproc.h (2 coalition types + reserve).
        #[repr(C)]
        struct CoalitionInfo {
            coalition_id: [u64; 2],
            reserved: [u64; 3],
        }

        /// The resource coalition id of a process.
        fn coalition_id(pid: i32) -> Option<u64> {
            let mut info = CoalitionInfo {
                coalition_id: [0; 2],
                reserved: [0; 3],
            };
            let size = std::mem::size_of::<CoalitionInfo>() as libc::c_int;
            let ret = unsafe {
                libc::proc_pidinfo(
                    pid,
                    PROC_PIDCOALITIONINFO,
                    0,
                    (&mut info as *mut CoalitionInfo).cast(),
                    size,
                )
            };
            (ret == size && info.coalition_id[0] != 0).then_some(info.coalition_id[0])
        }

        pub(super) fn find_webcontent(own: i32) -> Option<i32> {
            let own_coalition = coalition_id(own)?;
            all_pids().into_iter().find(|&pid| {
                pid > 0
                    && pid != own
                    && pid_path(pid)
                        .is_some_and(|path| path.contains("com.apple.WebKit.WebContent"))
                    && coalition_id(pid) == Some(own_coalition)
            })
        }

        fn all_pids() -> Vec<i32> {
            let mut pids = vec![0i32; 4096];
            let bytes = unsafe {
                libc::proc_listpids(
                    PROC_ALL_PIDS,
                    0,
                    pids.as_mut_ptr().cast(),
                    (pids.len() * std::mem::size_of::<i32>()) as libc::c_int,
                )
            };
            if bytes <= 0 {
                return Vec::new();
            }
            pids.truncate(bytes as usize / std::mem::size_of::<i32>());
            pids
        }

        fn pid_path(pid: i32) -> Option<String> {
            let mut buf = vec![0u8; PATH_MAX];
            let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), PATH_MAX as u32) };
            (len > 0).then(|| String::from_utf8_lossy(&buf[..len as usize]).into_owned())
        }

        /// user+system CPU time of a process in nanoseconds.
        fn cpu_time_ns(pid: i32, ns_per_tick: f64) -> Option<u64> {
            let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
            let ret = unsafe {
                libc::proc_pid_rusage(
                    pid,
                    libc::RUSAGE_INFO_V2,
                    (&mut info as *mut libc::rusage_info_v2).cast(),
                )
            };
            (ret == 0)
                .then(|| ((info.ri_user_time + info.ri_system_time) as f64 * ns_per_tick) as u64)
        }

        // mach_timebase_info is deprecated in libc in favor of the `mach2`
        // crate; one struct is not worth a dependency.
        #[allow(deprecated)]
        fn ns_per_tick() -> f64 {
            let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
            unsafe { libc::mach_timebase_info(&mut timebase) };
            if timebase.denom == 0 {
                return 1.0;
            }
            timebase.numer as f64 / timebase.denom as f64
        }
    }

    #[cfg(not(target_os = "macos"))]
    mod cpu {
        pub fn spawn_sampler(_profiler: super::Profiler) {}
    }

    /// Native main-thread stacks of the WebContent process, recorded with
    /// `/usr/bin/sample` in ~5 s chunks (opt-in: `--sample-webcontent`).
    /// This answers what WebKit itself is doing while the page's main thread
    /// is frozen outside JS (layer commits, GPU-process IPC, JSC GC, …) —
    /// nothing inside the page can see that. Sampling suspends the target's
    /// threads on every tick, so it stays a diagnostic flag, never a default.
    #[cfg(target_os = "macos")]
    mod native_stacks {
        use super::Profiler;
        use std::fmt::Write as _;
        use std::time::Duration;

        const CHUNK_SECONDS: u32 = 5;
        const TOP_STACKS: usize = 10;
        const TAIL_FRAMES: usize = 8;

        pub fn spawn(profiler: Profiler) {
            let _ = std::thread::Builder::new()
                .name("profiler-wc-sample".into())
                .spawn(move || run(profiler));
        }

        fn run(profiler: Profiler) {
            let own = std::process::id() as i32;
            let out_path = std::env::temp_dir().join(format!("shararam-wc-sample-{own}.txt"));
            loop {
                let Some(pid) = super::cpu::find_webcontent(own) else {
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                };
                let started_us = super::super::now_us();
                let output = std::process::Command::new("/usr/bin/sample")
                    .arg(pid.to_string())
                    .arg(CHUNK_SECONDS.to_string())
                    .arg("1") // 1 ms interval: sample count ≈ milliseconds
                    .arg("-file")
                    .arg(&out_path)
                    .output();
                let dur_us = super::super::now_us() - started_us;
                let ok = output.as_ref().is_ok_and(|out| out.status.success());
                if !ok {
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&out_path) else {
                    continue;
                };
                let _ = std::fs::remove_file(&out_path);
                if let Some((total, stacks)) = parse_main_thread(&text) {
                    let mut args = String::with_capacity(2048);
                    let _ = write!(args, "{{\"pid\":{pid},\"total\":{total},\"stacks\":[");
                    for (index, (count, chain)) in stacks.iter().enumerate() {
                        if index > 0 {
                            args.push(',');
                        }
                        let chain = serde_json::to_string(chain).unwrap_or_default();
                        let _ = write!(args, "[{count},{chain}]");
                    }
                    args.push_str("]}");
                    profiler.event("native", "wc_stacks", started_us, dur_us, Some(args));
                }
            }
        }

        /// Extracts the hottest leaf chains (leaf-first, up to
        /// [`TAIL_FRAMES`] frames) of the main thread from `sample` output.
        fn parse_main_thread(text: &str) -> Option<(u64, Vec<(u64, String)>)> {
            let mut in_graph = false;
            let mut in_main_thread = false;
            let mut total = 0u64;
            // stack of (depth, count, frame name) for the current path
            let mut path: Vec<(usize, u64, String)> = Vec::new();
            let mut leaves: Vec<(u64, String)> = Vec::new();
            let flush_leaf = |path: &[(usize, u64, String)], leaves: &mut Vec<(u64, String)>| {
                let Some(&(_, count, _)) = path.last() else {
                    return;
                };
                let chain: Vec<&str> = path
                    .iter()
                    .rev()
                    .take(TAIL_FRAMES)
                    .map(|(_, _, name)| name.as_str())
                    .collect();
                leaves.push((count, chain.join(" ← ")));
            };
            for line in text.lines() {
                if !in_graph {
                    in_graph = line.starts_with("Call graph:");
                    continue;
                }
                if line.starts_with("Total number in stack") {
                    break;
                }
                let Some(digit_at) = line.find(|c: char| c.is_ascii_digit()) else {
                    continue;
                };
                if digit_at < 4 {
                    continue;
                }
                let rest = &line[digit_at..];
                let count: u64 = rest
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
                if digit_at == 4 {
                    // a thread header line
                    flush_leaf(&path, &mut leaves);
                    path.clear();
                    in_main_thread = line.contains("com.apple.main-thread");
                    if in_main_thread {
                        total = count;
                    }
                    continue;
                }
                if !in_main_thread {
                    continue;
                }
                let depth = (digit_at - 4) / 2;
                let name = frame_name(rest);
                // the previous node was a leaf iff the tree does not descend
                if path.last().is_some_and(|&(d, _, _)| d >= depth) {
                    flush_leaf(&path, &mut leaves);
                }
                while path.last().is_some_and(|&(d, _, _)| d >= depth) {
                    path.pop();
                }
                path.push((depth, count, name));
            }
            flush_leaf(&path, &mut leaves);
            if total == 0 {
                return None;
            }
            leaves.sort_by(|a, b| b.0.cmp(&a.0));
            leaves.truncate(TOP_STACKS);
            Some((total, leaves))
        }

        /// `"1505 mach_msg  (in libsystem_kernel.dylib) + 24  [0x…]"` →
        /// `"mach_msg [libsystem_kernel]"`.
        fn frame_name(rest: &str) -> String {
            let after_count = rest
                .split_once(' ')
                .map(|(_, tail)| tail.trim_start())
                .unwrap_or(rest);
            let (symbol, tail) = after_count
                .split_once("  (in ")
                .unwrap_or((after_count, ""));
            let library = tail
                .split_once(')')
                .map(|(lib, _)| lib.trim_end_matches(".dylib"))
                .unwrap_or("");
            if library.is_empty() {
                symbol.trim().to_string()
            } else {
                format!("{} [{}]", symbol.trim(), library)
            }
        }

        #[cfg(test)]
        mod tests {
            use super::parse_main_thread;

            #[test]
            fn parses_main_thread_leaf_chains() {
                let text = "\
Call graph:
    100 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
    + 100 start  (in dyld) + 6992  [0x1]
    +   100 xpc_main  (in libxpc.dylib) + 64  [0x2]
    +     90 __CFRunLoopRun  (in CoreFoundation) + 1188  [0x3]
    +     ! 90 mach_msg  (in libsystem_kernel.dylib) + 24  [0x4]
    +     10 CA::Transaction::commit()  (in QuartzCore) + 1  [0x5]
    100 Thread_2
    + 100 something_else  (in lib) + 1  [0x6]

Total number in stack (recursive counted multiple, when >=5):
";
                let (total, stacks) = parse_main_thread(text).unwrap();
                assert_eq!(total, 100);
                assert_eq!(stacks[0].0, 90);
                assert!(stacks[0].1.starts_with("mach_msg [libsystem_kernel] ← __CFRunLoopRun"));
                assert_eq!(stacks[1].0, 10);
                assert!(stacks[1].1.starts_with("CA::Transaction::commit() [QuartzCore]"));
                assert!(!stacks.iter().any(|(_, chain)| chain.contains("something_else")));
            }
        }
    }

    /// Starts the WebContent native-stack sampler (`--sample-webcontent`).
    #[cfg(target_os = "macos")]
    pub fn spawn_webcontent_sampler(profiler: Profiler) {
        native_stacks::spawn(profiler);
    }

    #[cfg(not(target_os = "macos"))]
    pub fn spawn_webcontent_sampler(_profiler: Profiler) {}

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
                 CREATE TABLE IF NOT EXISTS samples(ts_us BIGINT, name VARCHAR, value DOUBLE);
                 CREATE TABLE IF NOT EXISTS snapshots(ts_us BIGINT, mime VARCHAR, bytes BLOB);",
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
                Some(Message::Snapshot(ts_us, mime, bytes)) => (|| {
                    let mut appender = connection.appender("snapshots")?;
                    appender.append_row(params![ts_us, mime, bytes])?;
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
            profiler.snapshot(
                1_700_000_000_050_000,
                "image/jpeg",
                vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00],
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
            let (snap_ts, snap_mime, snap_len): (i64, String, i64) = connection
                .query_row(
                    "SELECT ts_us, mime, octet_length(bytes) FROM snapshots",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(snap_ts, 1_700_000_000_050_000);
            assert_eq!(snap_mime, "image/jpeg");
            assert_eq!(snap_len, 5);
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
        pub fn snapshot(&self, _ts_us: i64, _mime: &str, _bytes: Vec<u8>) {}
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
