// Per-frame series of everything the profile records, put on the frame
// grid. No thresholds, no significance filters, no verdicts: the lanes
// view draws these aligned to the shared time axis, and the conclusions —
// trivial or unexpected — are the reader's to make.

import { query, toNumber } from "./db";
import { ProfileModel, formatMs } from "./model";
import { lowerBound } from "./view";

export type MetricUnit = "ms" | "count" | "mb";

export interface MetricSeries {
  key: string;
  label: string;
  color: string;
  unit: MetricUnit;
  /** per animation frame; NaN = not recorded for that frame */
  values: Float64Array;
  /** stable lane scale: p99.5 of the session, so zooming doesn't rescale */
  scaleMax: number;
}

const COLORS = {
  cpu: "#c98500",
  gpu: "#9085e9",
  page: "#8a8a80",
  render: "#d95926",
  mem: "#d55181",
  net: "#199e70"
};

// Render counters carried by the instrumented Ruffle build in the args of
// render/submit_frame ("sa") and render/render ("ra") of each tick.
const COUNTERS: { key: string; label: string; src: "sa" | "ra" }[] = [
  { key: "commands", label: "команды рендера", src: "sa" },
  { key: "shapes", label: "шейпы в кадре", src: "sa" },
  { key: "bitmaps", label: "битмапы в кадре", src: "sa" },
  { key: "rects", label: "прямоугольники", src: "sa" },
  { key: "stencil_masks", label: "stencil-маски", src: "sa" },
  { key: "alpha_masks", label: "alpha-маски", src: "sa" },
  { key: "blend_layer", label: "layer-бленды", src: "sa" },
  { key: "blend_complex", label: "сложные бленды", src: "sa" },
  { key: "blend_shader", label: "shader-бленды", src: "sa" },
  { key: "cache_commands", label: "cacheAsBitmap-команды", src: "sa" },
  { key: "cache_entries", label: "cacheAsBitmap-кэш", src: "sa" },
  { key: "display_objects", label: "объекты сцены", src: "ra" },
  { key: "offscreen_renders", label: "оффскрин-рендеры", src: "ra" },
  { key: "layer_blends_inlined", label: "инлайн-бленды", src: "ra" },
  { key: "textures_updated", label: "обновления текстур", src: "ra" },
  { key: "shapes_registered", label: "тесселяции шейпов", src: "ra" },
  { key: "bitmaps_registered", label: "новые битмапы", src: "ra" },
  { key: "bitmaps_decoded", label: "декодирования битмапов", src: "ra" },
  { key: "text_layouts", label: "layout текста", src: "ra" },
  { key: "objects_instantiated", label: "создано объектов", src: "ra" }
];

export function formatMetric(unit: MetricUnit, value: number): string {
  if (Number.isNaN(value)) return "·";
  if (unit === "ms") return value < 0.05 ? "0" : formatMs(value);
  if (unit === "mb") return `${value.toFixed(0)}МБ`;
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

function percentile(values: Float64Array, q: number): number {
  const valid: number[] = [];
  for (const value of values) if (!Number.isNaN(value)) valid.push(value);
  if (!valid.length) return 0;
  valid.sort((a, b) => a - b);
  return valid[Math.min(Math.floor(valid.length * q), valid.length - 1)];
}

export async function buildFrameSeries(
  model: ProfileModel
): Promise<{ series: MetricSeries[]; flat: string[] }> {
  const ends = model.frameTimesMs;
  const dts = model.frameDtMs;
  const n = ends.length;
  const zeros = () => new Float64Array(n);
  const nans = () => new Float64Array(n).fill(NaN);

  const mainMs = zeros();
  const scriptMs = zeros();
  const renderCpuMs = zeros();
  const gcMs = zeros();
  const gpuMs = zeros();
  const stallMs = zeros();
  const recMs = zeros();
  const netEvents = zeros();
  const wasmMb = nans();
  const counters = new Map<string, Float64Array>();
  for (const counter of COUNTERS) counters.set(counter.key, nans());

  const frameAt = (tMs: number): number => {
    const i = lowerBound(ends, tMs);
    return i < n ? i : -1;
  };

  // union coverage cursor per frame, for "how busy the main thread was"
  const reach = new Float64Array(n).fill(-Infinity);

  for (let i = 0; i < model.count; i++) {
    const kind = model.kinds[model.kindIds[i]];
    const start = model.startMs[i];
    const dur = model.durMs[i];
    const cat = kind.cat;
    if (cat === "http" || cat === "load" || cat === "swf" || cat === "asset") {
      const f = frameAt(start);
      if (f >= 0) netEvents[f]++;
      continue;
    }
    if (kind.source === "browser" && cat === "gpu") {
      const f = frameAt(start);
      if (f >= 0) gpuMs[f] = Math.max(gpuMs[f], dur);
      continue;
    }
    const isStall = kind.source === "browser" && cat === "browser" && kind.name === "stall";
    const isRec = kind.source === "browser" && cat === "rec";
    if (!(kind.source === "ruffle" || isStall || isRec)) continue;
    // session-long tunnel spans overlap every frame without being frame work
    if (dur <= 0 || dur > 5000) continue;
    const end = start + dur;
    let f = frameAt(start);
    if (f < 0) continue;
    while (f < n) {
      const w1 = ends[f];
      const w0 = w1 - dts[f];
      if (w0 >= end) break;
      const from = Math.max(start, w0);
      const to = Math.min(end, w1);
      if (to > from) {
        const uncovered = Math.max(from, reach[f]);
        if (to > uncovered) {
          mainMs[f] += to - uncovered;
          reach[f] = to;
        }
        const clip = to - from;
        if (isStall) stallMs[f] += clip;
        else if (isRec) recMs[f] += clip;
        else if (cat === "script" || cat === "input") scriptMs[f] += clip;
        else if (cat === "render" || cat === "text") renderCpuMs[f] += clip;
        else if (cat === "gc") gcMs[f] += clip;
      }
      f++;
    }
  }

  // wasm memory samples, carried forward per frame
  const memory = model.samples.find(sample => sample.name === "wasm_memory_bytes");
  if (memory && memory.timesMs.length) {
    let pointer = 0;
    let current = NaN;
    for (let f = 0; f < n; f++) {
      while (pointer < memory.timesMs.length && memory.timesMs[pointer] <= ends[f]) {
        current = memory.values[pointer] / 1048576;
        pointer++;
      }
      wasmMb[f] = current;
    }
  }

  // render counters from tick args (instrumented builds only)
  try {
    const { rows } = await query(
      "SELECT ts_us, name, args FROM events WHERE cat = 'render' AND name IN ('submit_frame', 'render') AND args IS NOT NULL ORDER BY ts_us"
    );
    for (const row of rows) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(String(row["args"])) as Record<string, unknown>;
      } catch {
        continue;
      }
      const f = frameAt((toNumber(row["ts_us"]) - model.t0Us) / 1000);
      if (f < 0) continue;
      const src = row["name"] === "submit_frame" ? "sa" : "ra";
      for (const counter of COUNTERS) {
        if (counter.src !== src) continue;
        const value = args[counter.key];
        if (value !== undefined) counters.get(counter.key)![f] = toNumber(value);
      }
    }
  } catch {
    /* profile without those events */
  }

  const series: MetricSeries[] = [];
  // A flat lane wastes a row, but its flatness is still information («столлов
  // не было») — flat metrics are listed in the section summary instead.
  const flat: string[] = [];
  const push = (key: string, label: string, color: string, unit: MetricUnit, values: Float64Array) => {
    let recorded = false;
    for (const value of values) {
      if (!Number.isNaN(value)) {
        recorded = true;
        break;
      }
    }
    if (!recorded) return;
    // p99.5 keeps one giant spike from flattening the lane, but for metrics
    // that are zero almost always (rare spikes ARE the signal) fall back to
    // the true max. Flat means flat: the metric never left zero.
    const p995 = percentile(values, 0.995);
    let max = 0;
    for (const value of values) if (!Number.isNaN(value) && value > max) max = value;
    if (max <= 0) {
      flat.push(label);
      return;
    }
    series.push({ key, label, color, unit, values, scaleMax: p995 > 0 ? p995 : max });
  };

  push("main_ms", "главный поток занят", COLORS.cpu, "ms", mainMs);
  push("script_ms", "скрипты AVM", COLORS.cpu, "ms", scriptMs);
  push("render_cpu_ms", "рендер на CPU", COLORS.cpu, "ms", renderCpuMs);
  push("gc_ms", "сборка мусора", COLORS.cpu, "ms", gcMs);
  push("gpu_wait_ms", "ожидание GPU", COLORS.gpu, "ms", gpuMs);
  push("stall_ms", "блокировки потока", COLORS.page, "ms", stallMs);
  push("rec_ms", "запись экрана", COLORS.page, "ms", recMs);
  for (const counter of COUNTERS) {
    push(counter.key, counter.label, COLORS.render, "count", counters.get(counter.key)!);
  }
  push("wasm_mb", "память wasm", COLORS.mem, "mb", wasmMb);
  push("net_events", "сетевые события", COLORS.net, "count", netEvents);
  return { series, flat };
}
