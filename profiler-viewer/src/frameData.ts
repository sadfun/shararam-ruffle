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

export interface FrameData {
  /** per frame, per category: attributed self-time ms */
  catMs: Float64Array[];
  /** per frame: sum of catMs — instrumented main-thread busy time */
  activeMs: Float64Array;
  /** per frame: longest gpu/fence_wait starting in the frame */
  gpuWaitMs: Float64Array;
  /** per frame: wasm memory MB carried forward (NaN before first sample) */
  memoryMb: Float64Array;
  memoryMaxMb: number;
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
  for (let i = 0; i < model.count; i++) {
    const kind = model.kinds[model.kindIds[i]];
    const start = model.startMs[i];
    const dur = model.durMs[i];

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

  // ---- args-dependent extras: input kinds, traces, mouse/key tracks ------
  const labelBySeq = new Map<number, string>();
  const traces: TraceLine[] = [];
  try {
    const { rows } = await query(
      `SELECT seq, ts_us, cat, name, args FROM events
       WHERE (cat = 'input' AND name = 'handle_event')
          OR (cat = 'external' AND name = 'call_out')
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
    catMs,
    activeMs,
    gpuWaitMs,
    memoryMb,
    memoryMaxMb,
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
