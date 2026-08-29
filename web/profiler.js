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

  // Main-thread stall detector. WKWebView has no Long Tasks API, so any
  // main-thread blockage outside instrumented spans would be invisible in the
  // profile. A 10ms heartbeat that arrives late means the thread was blocked
  // for that long; the event covers the blocked span.
  const HEARTBEAT_MS = 10;
  let heartbeatLast = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - heartbeatLast - HEARTBEAT_MS;
    heartbeatLast = now;
    if (document.hidden) return; // background timers are throttled, not stalled
    if (late > 20) event("browser", "stall", now - late, late);
  }, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => {
    heartbeatLast = performance.now();
  });

  // Screen recording (?rec=1 or ?rec=<fps>): a low-rate filmstrip of the
  // game canvas stored into the profile next to the events, so the viewer
  // can show what was on screen at any point of the timeline. Frames go
  // through captureStream + a hidden <video>: reading the WebGL canvas
  // directly returns blanks once its buffer has been composited.
  let recordingStarter = null;
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
    let busySince = 0;
    let frames = 0;

    const upload = (blob, tsUs) => {
      fetch(`/api/profiler/frame?ts_us=${tsUs}`, {
        method: "POST",
        headers: { "X-Shararam-Live-Capability": capability, "Content-Type": "image/jpeg" },
        body: blob
      })
        .catch(() => {})
        .finally(() => {
          busySince = 0;
          frames++;
        });
    };

    // Scaling and JPEG encoding happen in a worker: doing them on the main
    // thread (drawImage from the capture video + toBlob) blocked it for tens
    // of milliseconds and dropped a frame on almost every capture.
    const workerSource = `
      let canvas = null, ctx = null;
      onmessage = async ({ data }) => {
        const { bitmap, tsUs, width, height, quality } = data;
        try {
          if (!canvas || canvas.width !== width || canvas.height !== height) {
            canvas = new OffscreenCanvas(width, height);
            ctx = canvas.getContext("2d");
          }
          ctx.drawImage(bitmap, 0, 0, width, height);
          const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
          postMessage({ tsUs, blob });
        } catch (error) {
          postMessage({ tsUs, error: String(error) });
        } finally {
          bitmap.close();
        }
      };
    `;
    const canOffload =
      typeof OffscreenCanvas !== "undefined" &&
      typeof OffscreenCanvas.prototype.convertToBlob === "function" &&
      typeof createImageBitmap === "function";
    let worker = null;
    if (canOffload) {
      worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" })));
      worker.onmessage = ({ data }) => {
        if (data.error || !data.blob) {
          busySince = 0;
          return;
        }
        upload(data.blob, data.tsUs);
      };
      worker.onerror = () => {
        busySince = 0;
      };
    }

    const captureOne = () => {
      const t = performance.now();
      // A stuck pipeline (lost worker reply, hung upload) unlocks after 5s.
      if (document.hidden || (busySince && t - busySince < 5000)) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      const scale = Math.min(MAX_DIM / video.videoWidth, MAX_DIM / video.videoHeight, 1);
      const width = Math.max(Math.round(video.videoWidth * scale), 2);
      const height = Math.max(Math.round(video.videoHeight * scale), 2);
      const tsUs = Math.round(originUs + t * 1000);
      busySince = t;
      if (worker) {
        createImageBitmap(video)
          .then(bitmap => {
            worker.postMessage({ bitmap, tsUs, width, height, quality: JPEG_QUALITY }, [bitmap]);
            // The main-thread share of the capture; the rest runs in the worker.
            event("rec", "capture", t, performance.now() - t, { w: width, h: height });
          })
          .catch(() => {
            busySince = 0;
          });
        return;
      }
      if (scratch.width !== width || scratch.height !== height) {
        scratch.width = width;
        scratch.height = height;
      }
      scratchCtx.drawImage(video, 0, 0, width, height);
      scratch.toBlob(blob => {
        event("rec", "capture", t, performance.now() - t, { w: width, h: height, sync: true });
        if (!blob) {
          busySince = 0;
          return;
        }
        upload(blob, tsUs);
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

    recordingStarter = startRecording;
  }

  // GPU fence probe. At a steady 20-35 fps the main thread sits idle and every
  // JS-side collector sees nothing: rAF simply arrives late because the GPU /
  // compositor is still busy with the previous frame. The game canvas is
  // WebGL2, so inserting a fence into its queue each rAF and polling it
  // measures how long the queue actually drains — that otherwise-invisible
  // time becomes gpu/fence_wait spans.
  const startGpuProbe = canvas => {
    let gl = null;
    try {
      gl = canvas.getContext("webgl2");
    } catch (_) {}
    if (!gl || typeof gl.fenceSync !== "function") {
      marker("gpu_probe_unavailable", {});
      return;
    }
    const fences = [];
    const dropAll = () => {
      for (const fence of fences) {
        try {
          gl.deleteSync(fence.sync);
        } catch (_) {}
      }
      fences.length = 0;
    };
    const poll = () => {
      const now = performance.now();
      while (fences.length) {
        const head = fences[0];
        let status;
        try {
          status = gl.clientWaitSync(head.sync, 0, 0);
        } catch (_) {
          status = gl.WAIT_FAILED;
        }
        // The queue is FIFO: if the oldest fence isn't signalled, later ones aren't either.
        if (status === gl.TIMEOUT_EXPIRED) break;
        try {
          gl.deleteSync(head.sync);
        } catch (_) {}
        fences.shift();
        if (status !== gl.WAIT_FAILED && !document.hidden) {
          const wait = now - head.t;
          if (wait >= 8) event("gpu", "fence_wait", head.t, wait);
        }
      }
    };
    const insert = () => {
      poll();
      if (!document.hidden && fences.length < 8) {
        try {
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          if (sync) fences.push({ sync, t: performance.now() });
        } catch (_) {}
      }
      requestAnimationFrame(insert);
    };
    requestAnimationFrame(insert);
    setInterval(poll, 10);
    document.addEventListener("visibilitychange", dropAll);
    marker("gpu_probe_start", {});
  };

  const waitForCanvas = setInterval(() => {
    const canvas = window.__shararamRuffle?.getPlayer?.()?.shadowRoot?.querySelector("canvas");
    if (!canvas || !canvas.width) return;
    clearInterval(waitForCanvas);
    startGpuProbe(canvas);
    if (recordingStarter) recordingStarter(canvas);
  }, 500);

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
