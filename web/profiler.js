"use strict";

// Browser side of the profiling build. Loaded by app.js only when the server
// marks the page as a profiling build (<meta name="shararam-profiler">).
//
// Collects, on the page's performance timeline (performance.now()):
//   * every animation frame (the FPS graph),
//   * long tasks, resource timings (every HTTP load incl. SWFs), visibility,
//   * JS heap / wasm memory samples once a second,
//   * markers from the game's ExternalInterface callbacks,
//   * Ruffle's own events via window.__ruffleProfiler.drain() (the
//     shararam_profiler feature of the Ruffle fork),
// and posts batches to /api/profiler/events every 500 ms. The server
// converts everything to epoch microseconds and stores it in DuckDB.
(() => {
  const capability = window.__shararamCapability;
  if (!capability) return;
  const FLUSH_INTERVAL_MS = 500;
  const originUs = Math.round(performance.timeOrigin * 1000);

  let pending = { events: [], frames: [], samples: [], meta: [] };
  const event = (c, n, t, d, a) => pending.events.push({ t, d: d || 0, c, n, a });
  const marker = (name, args) => event("marker", name, performance.now(), 0, args);

  pending.meta.push(
    ["user_agent", navigator.userAgent],
    ["device_pixel_ratio", String(window.devicePixelRatio)],
    ["screen", `${screen.width}x${screen.height}`],
    ["hardware_concurrency", String(navigator.hardwareConcurrency || "")],
    ["page_origin_us", String(originUs)]
  );
  marker("profiler_start", { url: location.pathname });

  // Frame cadence. requestAnimationFrame stops in background tabs; the
  // visibility markers explain such gaps in the graph.
  let previousFrame = null;
  const onFrame = timestamp => {
    if (previousFrame !== null) pending.frames.push([timestamp, timestamp - previousFrame]);
    previousFrame = timestamp;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
  document.addEventListener("visibilitychange", () => {
    previousFrame = null;
    event("browser", "visibility", performance.now(), 0, { state: document.visibilityState });
  });

  const observe = (type, handler) => {
    try {
      new PerformanceObserver(list => list.getEntries().forEach(handler)).observe({ type, buffered: true });
    } catch (_) {}
  };
  observe("longtask", entry => {
    event("browser", "longtask", entry.startTime, entry.duration, {
      name: entry.name,
      attribution: entry.attribution?.[0]?.containerType || undefined
    });
  });
  observe("resource", entry => {
    // Skip our own telemetry traffic.
    if (entry.name.includes("/api/profiler/")) return;
    event("http", "resource", entry.startTime, entry.duration, {
      url: entry.name.replace(location.origin, ""),
      type: entry.initiatorType,
      status: entry.responseStatus,
      transfer: entry.transferSize,
      encoded: entry.encodedBodySize,
      decoded: entry.decodedBodySize,
      ttfb_ms: entry.responseStart ? +(entry.responseStart - entry.startTime).toFixed(1) : undefined,
      cached: entry.transferSize === 0 && entry.decodedBodySize > 0
    });
  });

  setInterval(() => {
    const now = performance.now();
    if (performance.memory) pending.samples.push([now, "js_heap_bytes", performance.memory.usedJSHeapSize]);
    const ruffle = window.__ruffleProfiler;
    if (ruffle) pending.samples.push([now, "wasm_memory_bytes", ruffle.memory()]);
  }, 1000);

  // The game talks to the page through ExternalInterface; app.js defines the
  // callbacks before loading this file. Keep the originals, add markers.
  for (const name of ["OnLoad", "OnGameEnter", "flashSetServerName", "OnUserEnterLocation", "SaveAvatar", "ExitGame"]) {
    const original = window[name];
    if (typeof original !== "function") continue;
    window[name] = function (...args) {
      marker(name, { args: args.map(value => (typeof value === "string" ? value.slice(0, 500) : value)) });
      return original.apply(this, args);
    };
  }

  const flush = final => {
    const ruffle = window.__ruffleProfiler ? window.__ruffleProfiler.drain() : null;
    const batch = pending;
    const empty = (!ruffle || ruffle === "[]") && !batch.events.length && !batch.frames.length && !batch.samples.length && !batch.meta.length;
    if (empty) return;
    pending = { events: [], frames: [], samples: [], meta: [] };
    const body = JSON.stringify({ originUs, ruffle, ...batch });
    if (final) {
      navigator.sendBeacon(`/api/profiler/events?cap=${encodeURIComponent(capability)}`, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch("/api/profiler/events", {
      method: "POST",
      headers: { "X-Shararam-Live-Capability": capability, "Content-Type": "application/json" },
      body
    }).catch(() => {});
  };
  setInterval(() => flush(false), FLUSH_INTERVAL_MS);
  window.addEventListener("pagehide", () => flush(true));
  window.addEventListener("beforeunload", () => flush(true));

  // Tell the player where the profile goes.
  const badge = document.getElementById("profiler-badge");
  fetch("/api/profiler/info", { headers: { "X-Shararam-Live-Capability": capability } })
    .then(response => response.json())
    .then(info => {
      if (!badge || !info.enabled) return;
      badge.hidden = false;
      badge.textContent = `● профиль: ${info.path}`;
      pending.meta.push(["profile_path", info.path || ""]);
    })
    .catch(() => {});

  window.__shararamProfiler = { flush, marker };
})();
