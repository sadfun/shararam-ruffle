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
            // Absolute so the badge shows a path a Windows user can find.
            let directory = std::path::absolute(&directory).unwrap_or(directory);
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

    /// Per-process CPU gauges (Windows). WebView2 runs the page in Chromium
    /// helper processes (`msedgewebview2.exe`, descendants of our own): the
    /// renderer executes JS + wasm, the GPU process talks to D3D, the browser
    /// process composites. Sampled every 500 ms into `cpu_client_pct` /
    /// `cpu_webcontent_pct` (renderers) / `cpu_gpu_pct` / `cpu_browser_pct`
    /// (percent of one core), plus `gpu_pct` from the "GPU Engine"
    /// performance counters (3D engines, capped at 100).
    #[cfg(windows)]
    mod cpu {
        use super::Profiler;
        use std::collections::HashMap;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{
            CloseHandle, FILETIME, HLOCAL, INVALID_HANDLE_VALUE, LocalFree,
        };
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        };
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, GetProcessTimes, GetThreadDescription, OpenProcess, OpenThread,
            PROCESS_QUERY_LIMITED_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION,
        };

        const SAMPLE_EVERY: Duration = Duration::from_millis(500);
        /// Helper processes come and go; re-discover them every N samples.
        const RESCAN_EVERY: u32 = 4;
        const WEBVIEW_EXE: &str = "msedgewebview2.exe";

        pub fn spawn_sampler(profiler: Profiler) {
            let _ = std::thread::Builder::new()
                .name("profiler-cpu".into())
                .spawn(move || run(profiler));
        }

        #[derive(Clone, Copy, PartialEq, Eq)]
        pub(super) enum Kind {
            Browser,
            Renderer,
            Gpu,
            Other,
        }

        struct Tracked {
            pid: u32,
            name: &'static str,
            last_100ns: u64,
        }

        fn run(profiler: Profiler) {
            let own = std::process::id();
            let mut kinds: HashMap<u32, Kind> = HashMap::new();
            let mut tracked: Vec<Tracked> = Vec::new();
            let mut gpu = gpu::Counter::open();
            let mut tick = 0u32;
            let mut last_wall = Instant::now();
            loop {
                std::thread::sleep(SAMPLE_EVERY);
                if tick % RESCAN_EVERY == 0 {
                    tracked = discover(own, &tracked, &mut kinds);
                }
                tick = tick.wrapping_add(1);
                let wall = Instant::now();
                let elapsed = wall.duration_since(last_wall).as_secs_f64();
                last_wall = wall;
                if elapsed <= 0.0 {
                    continue;
                }
                let mut by_name: HashMap<&'static str, f64> = HashMap::new();
                for entry in &mut tracked {
                    let Some(now) = cpu_time_100ns(entry.pid) else {
                        continue;
                    };
                    if entry.last_100ns > 0 && now >= entry.last_100ns {
                        let pct = (now - entry.last_100ns) as f64 / 1e7 / elapsed * 100.0;
                        *by_name.entry(entry.name).or_default() += pct;
                    }
                    entry.last_100ns = now;
                }
                for (name, pct) in by_name {
                    profiler.sample(name, (pct * 10.0).round() / 10.0);
                }
                if let Some(counter) = gpu.as_mut()
                    && let Some(pct) = counter.utilization_3d()
                {
                    profiler.sample("gpu_pct", (pct * 10.0).round() / 10.0);
                }
            }
        }

        /// Our own process plus the WebView2 helpers below it in the process
        /// tree, classified by their Chromium main-thread names.
        fn discover(own: u32, previous: &[Tracked], kinds: &mut HashMap<u32, Kind>) -> Vec<Tracked> {
            let carry = |pid: u32, name: &'static str| Tracked {
                pid,
                name,
                last_100ns: previous
                    .iter()
                    .find(|t| t.pid == pid && t.name == name)
                    .map(|t| t.last_100ns)
                    .unwrap_or(0),
            };
            let mut out = vec![carry(own, "cpu_client_pct")];
            for pid in webview_helpers(own) {
                let kind = *kinds.entry(pid).or_insert_with(|| classify(pid));
                let name = match kind {
                    Kind::Renderer => "cpu_webcontent_pct",
                    Kind::Gpu => "cpu_gpu_pct",
                    Kind::Browser => "cpu_browser_pct",
                    Kind::Other => continue,
                };
                out.push(carry(pid, name));
            }
            kinds.retain(|pid, _| out.iter().any(|t| t.pid == *pid));
            out
        }

        pub(super) struct Process {
            pub pid: u32,
            pub parent: u32,
            pub exe: String,
        }

        /// `msedgewebview2.exe` processes that descend from `own`.
        pub(super) fn webview_helpers(own: u32) -> Vec<u32> {
            let processes = snapshot_processes();
            let mut helpers: Vec<u32> = Vec::new();
            let mut frontier = vec![own];
            while let Some(parent) = frontier.pop() {
                for process in &processes {
                    if process.parent == parent
                        && process.pid != parent
                        && process.exe.eq_ignore_ascii_case(WEBVIEW_EXE)
                        && !helpers.contains(&process.pid)
                    {
                        helpers.push(process.pid);
                        frontier.push(process.pid);
                    }
                }
            }
            helpers
        }

        pub(super) fn snapshot_processes() -> Vec<Process> {
            let mut out = Vec::new();
            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                if snapshot == INVALID_HANDLE_VALUE {
                    return out;
                }
                let mut entry: PROCESSENTRY32W = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32FirstW(snapshot, &mut entry) != 0 {
                    loop {
                        out.push(Process {
                            pid: entry.th32ProcessID,
                            parent: entry.th32ParentProcessID,
                            exe: wide_str(&entry.szExeFile),
                        });
                        if Process32NextW(snapshot, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snapshot);
            }
            out
        }

        /// Thread ids and names (`SetThreadDescription`) of a process.
        pub(super) fn threads_of(pid: u32) -> Vec<(u32, String)> {
            let mut out = Vec::new();
            unsafe {
                let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
                if snapshot == INVALID_HANDLE_VALUE {
                    return out;
                }
                let mut entry: THREADENTRY32 = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                if Thread32First(snapshot, &mut entry) != 0 {
                    loop {
                        if entry.th32OwnerProcessID == pid {
                            let name = thread_name(entry.th32ThreadID).unwrap_or_default();
                            out.push((entry.th32ThreadID, name));
                        }
                        if Thread32Next(snapshot, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snapshot);
            }
            out
        }

        fn thread_name(tid: u32) -> Option<String> {
            unsafe {
                let thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, tid);
                if thread.is_null() {
                    return None;
                }
                let mut description: *mut u16 = std::ptr::null_mut();
                let result = GetThreadDescription(thread, &mut description);
                CloseHandle(thread);
                if result < 0 || description.is_null() {
                    return None;
                }
                let len = (0..).take_while(|&i| *description.add(i) != 0).count();
                let name = String::from_utf16_lossy(std::slice::from_raw_parts(description, len));
                LocalFree(description as HLOCAL);
                Some(name)
            }
        }

        /// Chromium names its main threads: CrRendererMain / CrGpuMain /
        /// CrBrowserMain (utility and other helpers are ignored).
        pub(super) fn classify(pid: u32) -> Kind {
            let threads = threads_of(pid);
            let has = |name: &str| threads.iter().any(|(_, n)| n == name);
            if has("CrRendererMain") {
                Kind::Renderer
            } else if has("CrGpuMain") {
                Kind::Gpu
            } else if has("CrBrowserMain") {
                Kind::Browser
            } else {
                Kind::Other
            }
        }

        /// kernel + user CPU time of a process in 100 ns units.
        fn cpu_time_100ns(pid: u32) -> Option<u64> {
            unsafe {
                let own = pid == std::process::id();
                let process = if own {
                    GetCurrentProcess()
                } else {
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
                };
                if process.is_null() {
                    return None;
                }
                let zero = FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let mut times = [zero; 4];
                let ok = GetProcessTimes(
                    process,
                    &mut times[0],
                    &mut times[1],
                    &mut times[2],
                    &mut times[3],
                );
                if !own {
                    CloseHandle(process);
                }
                if ok == 0 {
                    return None;
                }
                let as_u64 =
                    |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
                Some(as_u64(times[2]) + as_u64(times[3]))
            }
        }

        pub(super) fn wide_str(buffer: &[u16]) -> String {
            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            String::from_utf16_lossy(&buffer[..len])
        }

        /// GPU utilisation from the "GPU Engine" performance counters (what
        /// Task Manager's GPU column reads): the sum of every process's 3D
        /// engine share, capped at 100.
        mod gpu {
            use windows_sys::Win32::System::Performance::{
                PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA, PdhAddEnglishCounterW,
                PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
            };

            pub struct Counter {
                query: *mut std::ffi::c_void,
                counter: *mut std::ffi::c_void,
            }

            impl Counter {
                pub fn open() -> Option<Self> {
                    let mut query = std::ptr::null_mut();
                    let mut counter = std::ptr::null_mut();
                    unsafe {
                        if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                            return None;
                        }
                        let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage"
                            .encode_utf16()
                            .chain([0])
                            .collect();
                        if PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) != 0 {
                            PdhCloseQuery(query);
                            return None;
                        }
                        // Rate counters need two collections; prime the first.
                        PdhCollectQueryData(query);
                    }
                    Some(Self { query, counter })
                }

                pub fn utilization_3d(&mut self) -> Option<f64> {
                    unsafe {
                        if PdhCollectQueryData(self.query) != 0 {
                            return None;
                        }
                        let mut size = 0u32;
                        let mut count = 0u32;
                        let status = PdhGetFormattedCounterArrayW(
                            self.counter,
                            PDH_FMT_DOUBLE,
                            &mut size,
                            &mut count,
                            std::ptr::null_mut(),
                        );
                        if status != PDH_MORE_DATA || size == 0 {
                            return None;
                        }
                        let mut buffer = vec![0u64; size as usize / 8 + 1];
                        let items = buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
                        if PdhGetFormattedCounterArrayW(
                            self.counter,
                            PDH_FMT_DOUBLE,
                            &mut size,
                            &mut count,
                            items,
                        ) != 0
                        {
                            return None;
                        }
                        let mut total = 0.0;
                        for index in 0..count as usize {
                            let item = &*items.add(index);
                            if item.FmtValue.CStatus != 0 || item.szName.is_null() {
                                continue;
                            }
                            let len = (0..).take_while(|&i| *item.szName.add(i) != 0).count();
                            let name = String::from_utf16_lossy(std::slice::from_raw_parts(
                                item.szName,
                                len,
                            ));
                            if name.contains("engtype_3D") {
                                total += item.FmtValue.Anonymous.doubleValue;
                            }
                        }
                        Some(total.min(100.0))
                    }
                }
            }

            impl Drop for Counter {
                fn drop(&mut self) {
                    unsafe {
                        PdhCloseQuery(self.query);
                    }
                }
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    mod cpu {
        pub fn spawn_sampler(_profiler: super::Profiler) {}
    }

    /// Native main-thread stacks of the WebContent process, recorded with
    /// `/usr/bin/sample` in ~5 s chunks.
    /// This answers what WebKit itself is doing while the page's main thread
    /// is frozen outside JS (layer commits, GPU-process IPC, JSC GC, …) —
    /// nothing inside the page can see that. Sampling suspends the target's
    /// threads on every tick; `--no-webcontent-stacks` turns it off.
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

    /// Starts the WebContent native-stack sampler.
    #[cfg(target_os = "macos")]
    pub fn spawn_webcontent_sampler(profiler: Profiler) {
        native_stacks::spawn(profiler);
    }

    /// Native stacks of the WebView2 renderer's main thread (CrRendererMain),
    /// the Windows counterpart of sampling WebContent with `/usr/bin/sample`:
    /// the thread is suspended every 4 ms, walked with dbghelp (unwind tables
    /// come from the loaded images, so no symbols are needed to walk), and
    /// each 5 s chunk is reported as its hottest leaf chains. Names resolve
    /// only where dbghelp finds symbols (exports, local PDBs); everything
    /// else is `module+0xrva`, and a `native/wc_modules` event carries the
    /// PDB keys so a profile can be symbolised offline against the Microsoft
    /// symbol server.
    #[cfg(windows)]
    mod native_stacks {
        use super::Profiler;
        use std::collections::HashMap;
        use std::fmt::Write as _;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Diagnostics::Debug::{
            AddrModeFlat, CONTEXT, GetThreadContext, IMAGEHLP_MODULEW64, STACKFRAME64,
            SYMBOL_INFOW, SYMOPT_DEFERRED_LOADS, SYMOPT_NO_PROMPTS, SYMOPT_UNDNAME, StackWalk64,
            SymCleanup, SymFromAddrW, SymFunctionTableAccess64, SymGetModuleBase64,
            SymGetModuleInfoW64, SymInitializeW, SymPdb, SymSetOptions,
        };
        use windows_sys::Win32::System::Threading::{
            GetThreadTimes, OpenProcess, OpenThread, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
            ResumeThread, SuspendThread, THREAD_GET_CONTEXT, THREAD_QUERY_INFORMATION,
            THREAD_SUSPEND_RESUME,
        };

        const CHUNK: Duration = Duration::from_secs(5);
        const INTERVAL: Duration = Duration::from_millis(4);
        const MAX_FRAMES: usize = 32;
        const TOP_STACKS: usize = 10;
        const TAIL_FRAMES: usize = 8;
        const MAX_NAME: usize = 512;
        const IMAGE_FILE_MACHINE_AMD64: u32 = 0x8664;
        const CONTEXT_CONTROL_AMD64: u32 = 0x0010_0001;
        const CONTEXT_INTEGER_AMD64: u32 = 0x0010_0002;
        /// Stack marker for a frame outside every module: JIT code (V8, wasm)
        /// has no unwind tables, so the walk stops there.
        const JIT_FRAME: u64 = u64::MAX;
        /// Without a PDB dbghelp names an address after the nearest *export*,
        /// which in a 300 MB msedge.dll is usually a function far away; keep
        /// such names only when the address sits right at the export (syscall
        /// stubs, small system functions), otherwise report `module+0xrva`.
        const MAX_EXPORT_DISPLACEMENT: u64 = 256;

        pub fn spawn(profiler: Profiler) {
            let _ = std::thread::Builder::new()
                .name("profiler-wc-sample".into())
                .spawn(move || run(profiler));
        }

        fn run(profiler: Profiler) {
            let own = std::process::id();
            loop {
                let Some((pid, tid)) = find_renderer_main(own) else {
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                };
                let Some(mut target) = Target::open(pid, tid) else {
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                };
                let mut modules_reported = 0usize;
                loop {
                    let started_us = super::super::now_us();
                    let started = Instant::now();
                    let mut counts: HashMap<Vec<u64>, u64> = HashMap::new();
                    let mut total = 0u64;
                    let mut failures = 0u32;
                    while started.elapsed() < CHUNK && failures < 50 {
                        std::thread::sleep(INTERVAL);
                        match target.sample() {
                            Some(stack) => {
                                total += 1;
                                *counts.entry(stack).or_default() += 1;
                            }
                            None => failures += 1,
                        }
                    }
                    let dur_us = super::super::now_us() - started_us;
                    if total == 0 {
                        break; // the renderer went away; rediscover
                    }
                    let mut chains: HashMap<String, u64> = HashMap::new();
                    for (stack, count) in &counts {
                        let chain = stack
                            .iter()
                            .take(TAIL_FRAMES)
                            .map(|&pc| target.symbolize(pc))
                            .collect::<Vec<_>>()
                            .join(" ← ");
                        *chains.entry(chain).or_default() += count;
                    }
                    let mut stacks: Vec<(u64, String)> =
                        chains.into_iter().map(|(chain, n)| (n, chain)).collect();
                    stacks.sort_by(|a, b| b.0.cmp(&a.0));
                    stacks.truncate(TOP_STACKS);
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
                    if target.modules.len() > modules_reported {
                        modules_reported = target.modules.len();
                        profiler.event(
                            "native",
                            "wc_modules",
                            started_us,
                            0,
                            Some(target.modules_json()),
                        );
                    }
                    if failures >= 50 {
                        break;
                    }
                }
            }
        }

        /// The WebView2 renderer's main thread: of every renderer below us in
        /// the process tree, the one whose main thread has burnt the most CPU
        /// (the page; other renderers are idle helpers).
        fn find_renderer_main(own: u32) -> Option<(u32, u32)> {
            let mut best: Option<(u64, u32, u32)> = None;
            for pid in super::cpu::webview_helpers(own) {
                for (tid, name) in super::cpu::threads_of(pid) {
                    if name != "CrRendererMain" {
                        continue;
                    }
                    let cpu = thread_cpu_100ns(tid).unwrap_or(0);
                    if best.is_none_or(|(best_cpu, _, _)| cpu > best_cpu) {
                        best = Some((cpu, pid, tid));
                    }
                }
            }
            best.map(|(_, pid, tid)| (pid, tid))
        }

        fn thread_cpu_100ns(tid: u32) -> Option<u64> {
            unsafe {
                let thread = OpenThread(THREAD_QUERY_INFORMATION, 0, tid);
                if thread.is_null() {
                    return None;
                }
                let zero = windows_sys::Win32::Foundation::FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let mut times = [zero; 4];
                let ok = GetThreadTimes(
                    thread,
                    &mut times[0],
                    &mut times[1],
                    &mut times[2],
                    &mut times[3],
                );
                CloseHandle(thread);
                if ok == 0 {
                    return None;
                }
                let as_u64 = |t: windows_sys::Win32::Foundation::FILETIME| {
                    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
                };
                Some(as_u64(times[2]) + as_u64(times[3]))
            }
        }

        #[repr(C, align(16))]
        struct AlignedContext(CONTEXT);

        struct Module {
            name: String,
            base: u64,
            size: u32,
            /// PE TimeDateStamp: with `size` it keys the image itself on the
            /// symbol server (`<name>/<timestamp><size>/<name>`).
            timestamp: u32,
            /// File name of the image (`msedge.dll`), as the symbol server keys it.
            image: String,
            pdb: String,
            /// `<GUID><age>` as the Microsoft symbol server keys it.
            key: String,
        }

        struct Target {
            process: HANDLE,
            thread: HANDLE,
            symbols: HashMap<u64, String>,
            modules: Vec<Module>,
        }

        impl Target {
            fn open(pid: u32, tid: u32) -> Option<Self> {
                unsafe {
                    let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
                    if process.is_null() {
                        return None;
                    }
                    let thread = OpenThread(
                        THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
                        0,
                        tid,
                    );
                    if thread.is_null() {
                        CloseHandle(process);
                        return None;
                    }
                    SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME | SYMOPT_NO_PROMPTS);
                    if SymInitializeW(process, std::ptr::null(), 1) == 0 {
                        CloseHandle(thread);
                        CloseHandle(process);
                        return None;
                    }
                    Some(Self {
                        process,
                        thread,
                        symbols: HashMap::new(),
                        modules: Vec::new(),
                    })
                }
            }

            /// One stack, leaf first. `None` when the thread cannot be
            /// suspended any more (it exited).
            fn sample(&self) -> Option<Vec<u64>> {
                unsafe {
                    if SuspendThread(self.thread) == u32::MAX {
                        return None;
                    }
                    let mut context = AlignedContext(std::mem::zeroed());
                    context.0.ContextFlags = CONTEXT_CONTROL_AMD64 | CONTEXT_INTEGER_AMD64;
                    let mut stack = Vec::with_capacity(MAX_FRAMES);
                    if GetThreadContext(self.thread, &mut context.0) != 0 {
                        let mut frame: STACKFRAME64 = std::mem::zeroed();
                        frame.AddrPC.Offset = context.0.Rip;
                        frame.AddrPC.Mode = AddrModeFlat;
                        frame.AddrFrame.Offset = context.0.Rbp;
                        frame.AddrFrame.Mode = AddrModeFlat;
                        frame.AddrStack.Offset = context.0.Rsp;
                        frame.AddrStack.Mode = AddrModeFlat;
                        while stack.len() < MAX_FRAMES {
                            let ok = StackWalk64(
                                IMAGE_FILE_MACHINE_AMD64,
                                self.process,
                                self.thread,
                                &mut frame,
                                (&mut context.0 as *mut CONTEXT).cast(),
                                None,
                                Some(SymFunctionTableAccess64),
                                Some(SymGetModuleBase64),
                                None,
                            );
                            if ok == 0 || frame.AddrPC.Offset == 0 {
                                break;
                            }
                            let pc = frame.AddrPC.Offset;
                            if SymGetModuleBase64(self.process, pc) == 0 {
                                stack.push(JIT_FRAME);
                                break;
                            }
                            stack.push(pc);
                        }
                    }
                    ResumeThread(self.thread);
                    (!stack.is_empty()).then_some(stack)
                }
            }

            fn symbolize(&mut self, pc: u64) -> String {
                if pc == JIT_FRAME {
                    return "<jit>".to_string();
                }
                if let Some(name) = self.symbols.get(&pc) {
                    return name.clone();
                }
                let name = unsafe { self.symbolize_uncached(pc) };
                self.symbols.insert(pc, name.clone());
                name
            }

            unsafe fn symbolize_uncached(&mut self, pc: u64) -> String {
                unsafe {
                    let mut buffer =
                        vec![0u64; (std::mem::size_of::<SYMBOL_INFOW>() + MAX_NAME * 2) / 8 + 1];
                    let symbol = buffer.as_mut_ptr() as *mut SYMBOL_INFOW;
                    (*symbol).SizeOfStruct = std::mem::size_of::<SYMBOL_INFOW>() as u32;
                    (*symbol).MaxNameLen = MAX_NAME as u32;
                    let mut displacement = 0u64;
                    let named = SymFromAddrW(self.process, pc, &mut displacement, symbol) != 0
                        && (*symbol).NameLen > 0;
                    // After SymFromAddrW: deferred symbol loading has run, so
                    // SymType tells PDB symbols from export tables.
                    let mut module: IMAGEHLP_MODULEW64 = std::mem::zeroed();
                    module.SizeOfStruct = std::mem::size_of::<IMAGEHLP_MODULEW64>() as u32;
                    let module_name = if SymGetModuleInfoW64(self.process, pc, &mut module) != 0 {
                        self.remember_module(&module);
                        super::cpu::wide_str(&module.ModuleName)
                    } else {
                        String::new()
                    };
                    if named && (module.SymType == SymPdb || displacement < MAX_EXPORT_DISPLACEMENT)
                    {
                        let len = ((*symbol).NameLen as usize).min(MAX_NAME);
                        let name = String::from_utf16_lossy(std::slice::from_raw_parts(
                            (*symbol).Name.as_ptr(),
                            len,
                        ));
                        if module_name.is_empty() {
                            name
                        } else {
                            format!("{name} [{module_name}]")
                        }
                    } else if module.BaseOfImage != 0 {
                        format!("{module_name}+0x{:x}", pc - module.BaseOfImage)
                    } else {
                        format!("0x{pc:x}")
                    }
                }
            }

            fn remember_module(&mut self, module: &IMAGEHLP_MODULEW64) {
                if self.modules.iter().any(|m| m.base == module.BaseOfImage) {
                    return;
                }
                let guid = module.PdbSig70;
                let key = format!(
                    "{:08X}{:04X}{:04X}{}{:X}",
                    guid.data1,
                    guid.data2,
                    guid.data3,
                    guid.data4.iter().map(|b| format!("{b:02X}")).collect::<String>(),
                    module.PdbAge
                );
                let pdb = super::cpu::wide_str(&module.CVData);
                let pdb = pdb.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                self.modules.push(Module {
                    name: super::cpu::wide_str(&module.ModuleName),
                    base: module.BaseOfImage,
                    size: module.ImageSize,
                    timestamp: module.TimeDateStamp,
                    image: super::cpu::wide_str(&module.ImageName)
                        .rsplit(['\\', '/'])
                        .next()
                        .unwrap_or("")
                        .to_string(),
                    pdb,
                    key,
                });
            }

            fn modules_json(&self) -> String {
                let modules: Vec<serde_json::Value> = self
                    .modules
                    .iter()
                    .map(|m| {
                        serde_json::json!({
                            "name": m.name,
                            "base": format!("0x{:x}", m.base),
                            "size": m.size,
                            "timestamp": m.timestamp,
                            "image": m.image,
                            "pdb": m.pdb,
                            "key": m.key,
                        })
                    })
                    .collect();
                serde_json::json!({ "modules": modules }).to_string()
            }
        }

        impl Drop for Target {
            fn drop(&mut self) {
                unsafe {
                    SymCleanup(self.process);
                    CloseHandle(self.thread);
                    CloseHandle(self.process);
                }
            }
        }
    }
    /// Starts the renderer native-stack sampler (default in profiling
    /// builds; `--no-webcontent-stacks` skips it).
    #[cfg(windows)]
    pub fn spawn_webcontent_sampler(profiler: Profiler) {
        native_stacks::spawn(profiler);
    }

    #[cfg(not(any(target_os = "macos", windows)))]
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
