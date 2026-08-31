// Per-frame data in Scout's model: every main-thread event gets a self time
// (its span minus the spans of nested children), self times are attributed
// to the four Scout categories and clipped onto animation-frame windows.
// The stacked colored bars, the Summary numbers, Top Activities and the
// Activity Sequence all read from this one attribution, so they always agree.
//
// Nesting is inferred from timing: spans are emitted at close, so at equal
// start the longer span (and at equal length the later-closed, i.e. larger
// seq) is the ancestor — same rule Scout used for its telemetry stream.

import { query, toNumber } from "./db";
import { ProfileModel } from "./model";
import { lowerBound } from "./view";
import { categoryOfKind, CATEGORIES } from "./categories";

/** Spans longer than this are session-scoped, not frame work. */
export const SPAN_CAP_MS = 5000;

export interface TraceLine {
  tsMs: number;
  text: string;
}

export const TRACK_LABELS = ["Мышь", "Клавиатура", "Сеть", "Таймеры", "Рендер", "Trace"];
export const TRACK_ICONS = ["🖱", "⌨", "🌐", "⏱", "🎨", "💬"];

/** Aggregated `render/screen_grid` events: where draw commands land. */
export interface ScreenGridData {
  gw: number;
  gh: number;
  /** per frame: gw*gh cell draw counts, frame-major */
  draws: Uint32Array;
  /** same, but only commands inside blend/alpha-mask subtrees */
  heavy: Uint32Array;
  /** per frame: viewport pixel size the grid was recorded against */
  viewportW: Float32Array;
  viewportH: Float32Array;
  /** per frame: blend/alpha-mask subtrees with screen rects [x,y,w,h,kind] */
  hotByFrame: Map<number, [number, number, number, number, string][]>;
}

export interface FrameData {
  /** per frame: browser/stall time clipped onto the frame */
  stallMs: Float64Array;
  /** per frame: the part of stallMs that overlaps ruffle host_tick spans
   *  (main thread frozen inside our frame code — wasm/page work); the
   *  remainder froze between ticks (browser internals / compositor) */
  stallInTickMs: Float64Array;
  /** per frame, per category: attributed self-time ms */
  catMs: Float64Array[];
  /** per frame: sum of catMs — instrumented main-thread busy time */
  activeMs: Float64Array;
  /** per frame: longest gpu/fence_wait starting in the frame */
  gpuWaitMs: Float64Array;
  /** per frame: wasm memory MB carried forward (NaN before first sample) */
  memoryMb: Float64Array;
  memoryMaxMb: number;
  /** per frame: gc-arena heap MB carried forward (NaN if not recorded) */
  gcHeapMb: Float64Array;
  gcHeapMaxMb: number;
  /** per frame: process CPU % carried forward, by process key
   *  (client / webcontent / gpu; empty map when the host didn't sample) */
  cpu: Map<string, Float64Array>;
  cpuMax: number;
  /** per frame: browser's after-frame work — the gap between the last rAF
   *  callback returning and the next macrotask (layer commit, WebGL flush
   *  backpressure); NaN when not recorded */
  frameTailMs: Float64Array;
  /** per-frame counter deltas from the ruffle render-event args
   *  (avm1_objects, shapes_registered, gc_bytes excluded, …) */
  counters: Map<string, Float64Array>;
  /** AVM1 stack samples by event seq: collapsed stack + allocations */
  samplerBySeq: Map<number, { stack: string; alloc: number }>;
  /** screen-grid aggregates, or null when the profile has none */
  screenGrid: ScreenGridData | null;
  /** per track (TRACK_LABELS), per frame: event count */
  tracks: Uint16Array[];
  /** per event: self time ms (0 for non-main-thread events) */
  selfMs: Float64Array;
  /** per event: category index or -1 */
  eventCat: Int8Array;
  /** extra display label by event seq (event kinds, ExternalInterface names) */
  labelBySeq: Map<number, string>;
  /** trace log: ExternalInterface calls + page markers, in time order */
  traces: TraceLine[];
}

export async function buildFrameData(model: ProfileModel): Promise<FrameData> {
  const ends = model.frameTimesMs;
  const dts = model.frameDtMs;
  const n = ends.length;

  const catMs = CATEGORIES.map(() => new Float64Array(n));
  const stallMs = new Float64Array(n);
  const stallInTickMs = new Float64Array(n);
  const activeMs = new Float64Array(n);
  const gpuWaitMs = new Float64Array(n);
  const memoryMb = new Float64Array(n).fill(NaN);
  const tracks = TRACK_LABELS.map(() => new Uint16Array(n));
  const selfMs = new Float64Array(model.count);
  const eventCat = new Int8Array(model.count).fill(-1);

  const frameAt = (tMs: number): number => {
    const i = lowerBound(ends, tMs);
    return i < n ? i : -1;
  };

  const addToFrames = (target: Float64Array, a: number, b: number) => {
    let f = frameAt(a);
    if (f < 0) return;
    while (f < n) {
      const w1 = ends[f];
      const w0 = w1 - dts[f];
      if (w0 >= b) break;
      const from = Math.max(a, w0);
      const to = Math.min(b, w1);
      if (to > from) target[f] += to - from;
      f++;
    }
  };

  // ---- categorize + collect sweep participants and event tracks ----------
  interface Sweep {
    idx: number;
    start: number;
    end: number;
    cat: number;
  }
  const sweep: Sweep[] = [];
  const labelBySeq = new Map<number, string>();
  const tickStarts: number[] = [];
  const tickEnds: number[] = [];
  const stallIndexes: number[] = [];
  for (let i = 0; i < model.count; i++) {
    const kind = model.kinds[model.kindIds[i]];
    const start = model.startMs[i];
    const dur = model.durMs[i];

    if (kind.source === "ruffle" && kind.cat === "frame" && kind.name === "host_tick") {
      tickStarts.push(start);
      tickEnds.push(start + Math.min(Math.max(dur, 0), SPAN_CAP_MS));
    }
    if (kind.source === "browser" && kind.cat === "browser" && kind.name === "stall") {
      stallIndexes.push(i);
    }

    if (kind.source === "browser" && kind.cat === "gpu") {
      const f = frameAt(start);
      if (f >= 0) gpuWaitMs[f] = Math.max(gpuWaitMs[f], dur);
      continue;
    }

    // event tracks (any source, including async network)
    const f = frameAt(start);
    if (f >= 0) {
      if (["http", "load", "swf", "asset", "net", "rtmp", "socket"].includes(kind.cat)) {
        tracks[2][f]++;
      } else if (kind.cat === "script" && kind.name === "timers") tracks[3][f]++;
      else if (kind.cat === "render" && kind.name === "submit_frame") tracks[4][f]++;
      else if (kind.cat === "external" || kind.cat === "marker") tracks[5][f]++;
    }

    const cat = categoryOfKind(kind);
    if (cat < 0) continue;
    eventCat[i] = cat;
    if (dur <= 0 || dur > SPAN_CAP_MS) continue;
    sweep.push({ idx: i, start, end: start + dur, cat });
  }

  // ---- stall classification ----------------------------------------------
  // A stall overlapping ruffle host_tick spans means the main thread froze
  // inside our frame code (uninstrumented wasm/page work); a stall outside
  // any tick means the browser itself held the thread (compositor, its GC).
  const tickStartsSorted = Float64Array.from(tickStarts);
  for (const index of stallIndexes) {
    const s = model.startMs[index];
    const e = s + Math.min(Math.max(model.durMs[index], 0), SPAN_CAP_MS);
    if (e <= s) continue;
    addToFrames(stallMs, s, e);
    let overlap = 0;
    let t = lowerBound(tickStartsSorted, s - SPAN_CAP_MS);
    for (; t < tickStarts.length && tickStarts[t] < e; t++) {
      const from = Math.max(s, tickStarts[t]);
      const to = Math.min(e, tickEnds[t]);
      if (to > from) {
        overlap += to - from;
        addToFrames(stallInTickMs, from, to);
      }
    }
    const fraction = overlap / (e - s);
    labelBySeq.set(
      model.seq[index],
      fraction < 0.05
        ? "Блокировка потока (между тиками — браузер/композитор)"
        : fraction > 0.95
          ? "Блокировка потока (внутри тика Ruffle)"
          : "Блокировка потока (частично в тике)"
    );
  }

  // ---- self-time sweep ---------------------------------------------------
  // Sorted so ancestors precede descendants; the stack cursor walks each
  // span left to right, and the gaps between children are the self time.
  // Tie-break by seq DESC: spans are recorded at close, children close
  // first, so at equal timing the later-written span is the ancestor.
  const seq = model.seq;
  sweep.sort((a, b) => a.start - b.start || b.end - a.end || seq[b.idx] - seq[a.idx]);
  const stack: { end: number; cursor: number; cat: number; idx: number }[] = [];
  const attribute = (a: number, b: number, cat: number, idx: number) => {
    if (b <= a) return;
    selfMs[idx] += b - a;
    addToFrames(catMs[cat], a, b);
  };
  const EPS = 0.0005;
  for (const span of sweep) {
    while (stack.length && stack[stack.length - 1].end <= span.start + EPS) {
      const top = stack.pop()!;
      attribute(top.cursor, top.end, top.cat, top.idx);
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      attribute(parent.cursor, Math.min(span.start, parent.end), parent.cat, parent.idx);
      parent.cursor = Math.min(Math.max(parent.cursor, span.end), parent.end);
    }
    stack.push({ end: span.end, cursor: span.start, cat: span.cat, idx: span.idx });
  }
  while (stack.length) {
    const top = stack.pop()!;
    attribute(top.cursor, top.end, top.cat, top.idx);
  }

  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (const series of catMs) sum += series[f];
    // attribution never exceeds the union of spans, but frame windows can
    // overlap when rAF dt was reported longer than the actual gap
    activeMs[f] = Math.min(sum, dts[f]);
  }

  // ---- wasm memory carried forward --------------------------------------
  let memoryMaxMb = 0;
  const memory = model.samples.find(sample => sample.name === "wasm_memory_bytes");
  if (memory && memory.timesMs.length) {
    let pointer = 0;
    let current = NaN;
    for (let f = 0; f < n; f++) {
      while (pointer < memory.timesMs.length && memory.timesMs[pointer] <= ends[f]) {
        current = memory.values[pointer] / 1048576;
        pointer++;
      }
      memoryMb[f] = current;
      if (!Number.isNaN(current) && current > memoryMaxMb) memoryMaxMb = current;
    }
  }

  // ---- process CPU gauges (host-side sampler, macOS) ---------------------
  const cpu = new Map<string, Float64Array>();
  let cpuMax = 0;
  for (const sample of model.samples) {
    const match = sample.name.match(/^cpu_(\w+)_pct$/);
    if (!match || !sample.timesMs.length) continue;
    const series = new Float64Array(n).fill(NaN);
    let pointer = 0;
    let current = NaN;
    for (let f = 0; f < n; f++) {
      while (pointer < sample.timesMs.length && sample.timesMs[pointer] <= ends[f]) {
        current = sample.values[pointer];
        pointer++;
      }
      series[f] = current;
      if (!Number.isNaN(current) && current > cpuMax) cpuMax = current;
    }
    cpu.set(match[1], series);
  }

  // ---- browser after-frame tail (page-side gauge) ------------------------
  const frameTailMs = new Float64Array(n).fill(NaN);
  const tail = model.samples.find(sample => sample.name === "post_raf_tail_ms");
  if (tail) {
    for (let i = 0; i < tail.timesMs.length; i++) {
      const f = frameAt(tail.timesMs[i]);
      if (f >= 0 && !(frameTailMs[f] >= tail.values[i])) frameTailMs[f] = tail.values[i];
    }
  }

  // ---- per-frame counters + gc heap from the ruffle render event ---------
  const gcHeapMb = new Float64Array(n).fill(NaN);
  let gcHeapMaxMb = 0;
  const counters = new Map<string, Float64Array>();
  try {
    const { rows } = await query(
      `SELECT ts_us, args FROM events
       WHERE source = 'ruffle' AND cat = 'render' AND name = 'render' AND args IS NOT NULL
       ORDER BY ts_us`
    );
    for (const row of rows) {
      const tsMs = (toNumber(row["ts_us"]) - model.t0Us) / 1000;
      const f = frameAt(tsMs);
      if (f < 0) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(String(row["args"])) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(args)) {
        if (typeof value !== "number") continue;
        if (key === "gc_bytes") {
          gcHeapMb[f] = value / 1048576;
          continue;
        }
        let series = counters.get(key);
        if (!series) counters.set(key, (series = new Float64Array(n)));
        series[f] += value;
      }
    }
    // carry the gc heap gauge forward through frames without a ruffle render
    let current = NaN;
    for (let f = 0; f < n; f++) {
      if (!Number.isNaN(gcHeapMb[f])) current = gcHeapMb[f];
      else gcHeapMb[f] = current;
      if (!Number.isNaN(current) && current > gcHeapMaxMb) gcHeapMaxMb = current;
    }
  } catch {
    /* profile without args */
  }

  // ---- AVM1 stack samples ------------------------------------------------
  const samplerBySeq = new Map<number, { stack: string; alloc: number }>();
  try {
    const { rows } = await query(
      `SELECT seq, args FROM events
       WHERE source = 'ruffle' AND cat = 'sampler' AND name = 'avm1' AND args IS NOT NULL`
    );
    for (const row of rows) {
      try {
        const args = JSON.parse(String(row["args"])) as Record<string, unknown>;
        const stack = String(args["stack"] ?? "");
        if (!stack) continue;
        samplerBySeq.set(toNumber(row["seq"]), {
          stack,
          alloc: typeof args["alloc"] === "number" ? args["alloc"] : 0
        });
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* profile without sampler */
  }

  // ---- screen grid -------------------------------------------------------
  let screenGrid: ScreenGridData | null = null;
  try {
    const { rows } = await query(
      `SELECT ts_us, args FROM events
       WHERE source = 'ruffle' AND cat = 'render' AND name = 'screen_grid' AND args IS NOT NULL
       ORDER BY ts_us`
    );
    for (const row of rows) {
      let args: {
        vw?: number;
        vh?: number;
        gw?: number;
        gh?: number;
        draws?: number[];
        heavy?: [number, number][];
        hot?: [number, number, number, number, string][];
      };
      try {
        args = JSON.parse(String(row["args"]));
      } catch {
        continue;
      }
      const gw = args.gw ?? 0;
      const gh = args.gh ?? 0;
      if (!gw || !gh || !Array.isArray(args.draws)) continue;
      if (!screenGrid) {
        screenGrid = {
          gw,
          gh,
          draws: new Uint32Array(n * gw * gh),
          heavy: new Uint32Array(n * gw * gh),
          viewportW: new Float32Array(n),
          viewportH: new Float32Array(n),
          hotByFrame: new Map()
        };
      }
      if (gw !== screenGrid.gw || gh !== screenGrid.gh) continue;
      const tsMs = (toNumber(row["ts_us"]) - model.t0Us) / 1000;
      const f = frameAt(tsMs);
      if (f < 0) continue;
      const base = f * gw * gh;
      const cells = Math.min(args.draws.length, gw * gh);
      for (let c = 0; c < cells; c++) screenGrid.draws[base + c] += args.draws[c];
      if (Array.isArray(args.heavy)) {
        for (const [cell, count] of args.heavy) {
          if (cell >= 0 && cell < gw * gh) screenGrid.heavy[base + cell] += count;
        }
      }
      screenGrid.viewportW[f] = args.vw ?? 0;
      screenGrid.viewportH[f] = args.vh ?? 0;
      if (Array.isArray(args.hot) && args.hot.length) {
        const list = screenGrid.hotByFrame.get(f) ?? [];
        for (const rect of args.hot) list.push(rect);
        screenGrid.hotByFrame.set(f, list);
      }
    }
  } catch {
    /* profile without screen grid */
  }

  // ---- args-dependent extras: input kinds, traces, mouse/key tracks ------
  const traces: TraceLine[] = [];
  try {
    const { rows } = await query(
      `SELECT seq, ts_us, cat, name, args FROM events
       WHERE (cat = 'input' AND name = 'handle_event')
          OR (cat = 'external' AND name = 'call_out')
          OR (cat = 'script' AND name = 'array_sort')
          OR (cat = 'browser' AND name = 'stall' AND args IS NOT NULL)
          OR cat = 'marker'
       ORDER BY ts_us`
    );
    for (const row of rows) {
      const tsMs = (toNumber(row["ts_us"]) - model.t0Us) / 1000;
      const seq = toNumber(row["seq"]);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(row["args"] ?? "{}")) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      const f = frameAt(tsMs);
      if (row["cat"] === "input") {
        const kind = String(args["kind"] ?? "");
        labelBySeq.set(seq, `Обработка события "${kind || "?"}"`);
        if (f >= 0) {
          if (kind.startsWith("mouse")) tracks[0][f]++;
          else if (kind.startsWith("key")) tracks[1][f]++;
        }
      } else if (row["cat"] === "script") {
        labelBySeq.set(
          seq,
          `Array.sort (n=${args["n"] ?? "?"}${args["sort_on"] ? ", sortOn" : ""})`
        );
      } else if (row["cat"] === "browser") {
        // phase recorded by the worker sampler at freeze time (see
        // web/profiler.js); more precise than the tick-overlap fallback
        const PHASE_LABELS: Record<string, string> = {
          raf: "замёрз в rAF-колбэке",
          timer: "замёрз в таймер-колбэке",
          capture: "замёрз в захвате записи",
          idle: "замёрз вне JS — браузер/композитор"
        };
        const at = String(args["at_freeze"] ?? "");
        if (at) labelBySeq.set(seq, `Блокировка потока (${PHASE_LABELS[at] ?? at})`);
      } else if (row["cat"] === "external") {
        const target = String(args["name"] ?? "");
        const callArgs = Array.isArray(args["args"]) ? (args["args"] as unknown[]) : [];
        const text = callArgs.map(value => String(value)).join(" ");
        labelBySeq.set(seq, `ExternalInterface: ${target}(${text.slice(0, 60)})`);
        traces.push({ tsMs, text: text || target });
      } else {
        traces.push({ tsMs, text: `[маркер] ${row["name"]} ${String(row["args"] ?? "")}` });
      }
    }
  } catch {
    /* profile without args */
  }

  return {
    stallMs,
    stallInTickMs,
    catMs,
    activeMs,
    gpuWaitMs,
    memoryMb,
    memoryMaxMb,
    gcHeapMb,
    gcHeapMaxMb,
    cpu,
    cpuMax,
    frameTailMs,
    counters,
    samplerBySeq,
    screenGrid,
    tracks,
    selfMs,
    eventCat,
    labelBySeq,
    traces
  };
}

/** First..last event index whose span intersects [aMs, bMs] — a scan helper. */
export function eventsInRange(
  model: ProfileModel,
  aMs: number,
  bMs: number,
  visit: (index: number) => void
) {
  // events are sorted by start; spans are capped for frame work, so walking
  // back SPAN_CAP_MS before the range start catches everything that overlaps
  const from = lowerBound(model.startMs, aMs - SPAN_CAP_MS);
  for (let i = from; i < model.count; i++) {
    const start = model.startMs[i];
    if (start >= bMs) break;
    const dur = Math.min(Math.max(model.durMs[i], 0), SPAN_CAP_MS);
    if (start + dur <= aMs && dur > 0) continue;
    if (start < aMs && dur === 0) continue;
    visit(i);
  }
}
