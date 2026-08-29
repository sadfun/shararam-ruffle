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

  // Screen recording (?rec=1 or ?rec=<fps>): a low-rate filmstrip of the
  // game canvas stored into the profile next to the events, so the viewer
  // can show what was on screen at any point of the timeline. Frames go
  // through captureStream + a hidden <video>: reading the WebGL canvas
  // directly returns blanks once its buffer has been composited.
  const recParam = new URLSearchParams(location.search).get("rec");
  const recFps = recParam === null || recParam === "0" || recParam === "off"
    ? 0
    : recParam === "1" || recParam === "on" || recParam === "true"
      ? 2 // "1" reads as "on", not "1 fps"; the default rate is 2 fps
      : Math.min(Math.max(Number(recParam) || 2, 0.2), 10);
  if (recFps > 0) {
    const MAX_DIM = 480;
    const JPEG_QUALITY = 0.55;
    const scratch = document.createElement("canvas");
    const scratchCtx = scratch.getContext("2d");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none";
    let uploading = false;
    let frames = 0;

    const captureOne = () => {
      if (document.hidden || uploading || video.readyState < 2 || !video.videoWidth) return;
      const t = performance.now();
      const scale = Math.min(MAX_DIM / video.videoWidth, MAX_DIM / video.videoHeight, 1);
      const width = Math.max(Math.round(video.videoWidth * scale), 2);
      const height = Math.max(Math.round(video.videoHeight * scale), 2);
      if (scratch.width !== width || scratch.height !== height) {
        scratch.width = width;
        scratch.height = height;
      }
      scratchCtx.drawImage(video, 0, 0, width, height);
      scratch.toBlob(blob => {
        if (!blob || uploading) return;
        uploading = true;
        const tsUs = Math.round(originUs + t * 1000);
        fetch(`/api/profiler/frame?ts_us=${tsUs}`, {
          method: "POST",
          headers: { "X-Shararam-Live-Capability": capability, "Content-Type": "image/jpeg" },
          body: blob
        })
          .catch(() => {})
          .finally(() => {
            uploading = false;
            frames++;
          });
      }, "image/jpeg", JPEG_QUALITY);
    };

    const startRecording = canvas => {
      let stream;
      try {
        stream = canvas.captureStream(Math.max(recFps * 2, 4));
      } catch (error) {
        marker("rec_error", { error: String(error) });
        return;
      }
      video.srcObject = stream;
      document.body.appendChild(video);
      video.play().catch(error => marker("rec_error", { error: String(error) }));
      pending.meta.push(["recording_fps", String(recFps)]);
      marker("rec_start", { fps: recFps, canvas: `${canvas.width}x${canvas.height}` });
      setInterval(captureOne, Math.round(1000 / recFps));
    };

    const waitForCanvas = setInterval(() => {
      const canvas = window.__shararamRuffle?.getPlayer?.()?.shadowRoot?.querySelector("canvas");
      if (!canvas || !canvas.width) return;
      clearInterval(waitForCanvas);
      startRecording(canvas);
    }, 500);
  }

  // Tell the player where the profile goes.
  const badge = document.getElementById("profiler-badge");
  fetch("/api/profiler/info", { headers: { "X-Shararam-Live-Capability": capability } })
    .then(response => response.json())
    .then(info => {
      if (!badge || !info.enabled) return;
      badge.hidden = false;
      badge.textContent = `● профиль: ${info.path}${recFps > 0 ? ` · rec ${recFps}fps` : ""}`;
      pending.meta.push(["profile_path", info.path || ""]);
    })
    .catch(() => {});

  window.__shararamProfiler = { flush, marker };
})();
