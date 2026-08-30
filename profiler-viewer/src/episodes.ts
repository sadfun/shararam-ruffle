// Episode diagnosis: the session is segmented into deviations from the
// stable framerate ("episodes"), and each episode is explained as a diff
// of every recorded per-frame metric against the local norm — the workflow
// "what is different when it's slow" built in, instead of raw event lists.

import { query, toNumber } from "./db";
import { ProfileModel, formatMs, formatClock } from "./model";
import { severityColor } from "./frames";
import { lowerBound } from "./view";

const GAP_MS = 500;
/** Good frames allowed between bad ones before an episode closes. */
const MERGE_GAP_MS = 1500;
/** Neighborhood used for the local baseline. */
const NEAR_MS = 15000;

type MetricFmt = "ms" | "count" | "mb";

interface MetricDef {
  key: string;
  label: string;
  fmt: MetricFmt;
}

// Render counters carried by the instrumented Ruffle build in the args of
// render/submit_frame ("sa") and render/render ("ra") of each tick.
const COUNTER_METRICS: { key: string; label: string; src: "sa" | "ra" }[] = [
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

const EVENT_METRICS: MetricDef[] = [
  { key: "script_ms", label: "скрипты AVM, мс/кадр", fmt: "ms" },
  { key: "render_cpu_ms", label: "рендер на CPU, мс/кадр", fmt: "ms" },
  { key: "gc_ms", label: "сборка мусора, мс/кадр", fmt: "ms" },
  { key: "gpu_wait_ms", label: "ожидание GPU, мс/кадр", fmt: "ms" },
  { key: "stall_ms", label: "блокировки потока, мс/кадр", fmt: "ms" },
  { key: "rec_ms", label: "запись экрана, мс/кадр", fmt: "ms" },
  { key: "net_events", label: "сетевые события/кадр", fmt: "count" },
  { key: "wasm_mb", label: "память wasm, МБ", fmt: "mb" }
];

export interface Deviation {
  def: MetricDef;
  base: number;
  value: number;
  /** value / base; Infinity when the metric appeared from zero */
  ratio: number;
  score: number;
}

export interface Episode {
  /** indices of the slow frames (into model.frameTimesMs) */
  frames: number[];
  startMs: number;
  endMs: number;
  durationMs: number;
  worstIdx: number;
  sumExcessMs: number;
  kind: "spike" | "degradation" | "ambient";
  label: string;
  avgFps: number;
  verdictTitle: string;
  verdictParts: string[];
  flags: string[];
  deviations: Deviation[];
}

export interface Diagnosis {
  stableDtMs: number;
  /** frames at or below this are the baseline ("норма") */
  goodThresholdMs: number;
  /** frames above this form localized episodes (auto-raised in jittery sessions) */
  badThresholdMs: number;
  episodes: Episode[];
  hasCounters: boolean;
  hasGpu: boolean;
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function meanValid(metric: Float64Array, frames: number[]): number {
  let sum = 0;
  let count = 0;
  for (const i of frames) {
    const value = metric[i];
    if (!Number.isNaN(value)) {
      sum += value;
      count++;
    }
  }
  return count ? sum / count : NaN;
}

function collectValid(metric: Float64Array, frames: number[]): number[] {
  const out: number[] = [];
  for (const i of frames) if (!Number.isNaN(metric[i])) out.push(metric[i]);
  return out;
}

export async function buildDiagnosis(model: ProfileModel): Promise<Diagnosis> {
  const ends = model.frameTimesMs;
  const dts = model.frameDtMs;
  const n = ends.length;
  const metrics = new Map<string, Float64Array>();
  const defs: MetricDef[] = [];
  const zeros = () => new Float64Array(n);
  const nans = () => new Float64Array(n).fill(NaN);

  for (const counter of COUNTER_METRICS) {
    defs.push({ key: counter.key, label: counter.label, fmt: "count" });
    metrics.set(counter.key, nans());
  }
  for (const def of EVENT_METRICS) {
    defs.push(def);
    metrics.set(def.key, def.key === "wasm_mb" ? nans() : zeros());
  }

  const frameAt = (tMs: number): number => {
    const i = lowerBound(ends, tMs);
    return i < n ? i : -1;
  };

  // --- distribute the already-loaded events into frame windows ---
  const scriptMs = metrics.get("script_ms")!;
  const renderCpuMs = metrics.get("render_cpu_ms")!;
  const gcMs = metrics.get("gc_ms")!;
  const gpuMs = metrics.get("gpu_wait_ms")!;
  const stallMs = metrics.get("stall_ms")!;
  const recMs = metrics.get("rec_ms")!;
  const netEvents = metrics.get("net_events")!;
  // union coverage of main-thread events per frame ("how busy the thread was")
  const mainMs = zeros();
  const reach = new Float64Array(n).fill(-Infinity);
  let hasGpu = false;

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
      hasGpu = true;
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

  // --- wasm memory samples, carried forward per frame ---
  const memory = model.samples.find(sample => sample.name === "wasm_memory_bytes");
  if (memory && memory.timesMs.length) {
    const wasmMb = metrics.get("wasm_mb")!;
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

  // --- render counters from tick args (instrumented builds only) ---
  let hasCounters = false;
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
      for (const counter of COUNTER_METRICS) {
        if (counter.src !== src) continue;
        const value = args[counter.key];
        if (value !== undefined) {
          metrics.get(counter.key)![f] = toNumber(value);
          hasCounters = true;
        }
      }
    }
  } catch {
    /* profile without those events */
  }

  // --- game markers (OnLoad, OnUserEnterLocation, …) for episode context ---
  let markers: { tsMs: number; name: string }[] = [];
  try {
    const { rows } = await query("SELECT ts_us, name FROM events WHERE cat = 'marker' ORDER BY ts_us");
    markers = rows
      .map(row => ({
        tsMs: (toNumber(row["ts_us"]) - model.t0Us) / 1000,
        name: String(row["name"])
      }))
      // technical markers of the profiler itself are not game context
      .filter(m => !/^(profiler|gpu_probe|rec)/.test(m.name));
  } catch {
    /* no markers */
  }

  // --- the stable regime and episode segmentation ---
  const validDts: number[] = [];
  for (let i = 0; i < n; i++) if (dts[i] <= GAP_MS) validDts.push(dts[i]);
  const stableDtMs = median(validDts) || 16.7;
  const goodThresholdMs = Math.max(25, stableDtMs * 1.4);
  // In a uniformly jittery session a fixed threshold merges everything into
  // one session-long "episode". Raise the bar until localized episodes cover
  // at most ~8% of frames; the jitter in between is reported separately as
  // the ambient pseudo-episode below.
  let badThresholdMs = goodThresholdMs;
  for (const candidate of [goodThresholdMs, 36, 44, 50, 60, 80, 100, 150]) {
    if (candidate < goodThresholdMs) continue;
    badThresholdMs = candidate;
    let over = 0;
    for (const dt of validDts) if (dt > candidate) over++;
    if (validDts.length === 0 || over / validDts.length <= 0.08) break;
  }

  const episodes: Episode[] = [];
  let current: number[] | null = null;
  let lastBadEndMs = 0;
  const close = () => {
    if (!current) return;
    const frames = current;
    current = null;
    let worstIdx = frames[0];
    let sumExcessMs = 0;
    for (const i of frames) {
      sumExcessMs += dts[i] - stableDtMs;
      if (dts[i] > dts[worstIdx]) worstIdx = i;
    }
    if (sumExcessMs < 60 && dts[worstIdx] < 80) return;
    const startMs = ends[frames[0]] - dts[frames[0]];
    const endMs = ends[frames[frames.length - 1]];
    const durationMs = endMs - startMs;
    // the felt low: average of the slow frames themselves (good frames in
    // between would flatter the number)
    let badSum = 0;
    for (const i of frames) badSum += dts[i];
    const avgFps = 1000 / (badSum / frames.length);
    const kind: Episode["kind"] =
      frames.length <= 3 && durationMs <= 600 ? "spike" : "degradation";
    // dense stretch of slow frames = a real dip; sparse slow frames spread
    // over a long span = periodic jank, a different felt experience
    const density = frames.length / (frames[frames.length - 1] - frames[0] + 1);
    const seconds = `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)} с`;
    const label =
      kind === "spike"
        ? `спайк ${Math.round(dts[worstIdx])} мс`
        : density >= 0.4
          ? `просадка до ${avgFps.toFixed(0)} к/с · ${seconds}`
          : `дёргания ~${Math.round(badSum / frames.length)} мс ×${frames.length} · ${seconds}`;
    episodes.push({
      frames,
      startMs,
      endMs,
      durationMs,
      worstIdx,
      sumExcessMs,
      kind,
      label,
      avgFps,
      verdictTitle: "",
      verdictParts: [],
      flags: [],
      deviations: []
    });
  };
  for (let i = 0; i < n; i++) {
    const dt = dts[i];
    if (dt > GAP_MS) {
      close();
      continue;
    }
    if (dt >= badThresholdMs) {
      if (current && ends[i] - dt - lastBadEndMs > MERGE_GAP_MS) close();
      if (!current) current = [];
      current.push(i);
      lastBadEndMs = ends[i];
    } else if (current && ends[i] - lastBadEndMs > MERGE_GAP_MS) {
      close();
    }
  }
  close();

  // --- ambient jitter: frames between the two thresholds, outside episodes.
  // When they are a большая доля сессии, that IS the main finding ("игра
  // фоном не дотягивает до стабильного кадра") — report it as a session-wide
  // pseudo-episode with the same diff/verdict machinery.
  const insideEpisode = (i: number): boolean =>
    episodes.some(ep => ends[i] > ep.startMs && ends[i] - dts[i] < ep.endMs);
  const ambientFrames: number[] = [];
  if (badThresholdMs > goodThresholdMs) {
    for (let i = 0; i < n; i++) {
      if (dts[i] > GAP_MS || dts[i] <= goodThresholdMs || dts[i] >= badThresholdMs) continue;
      if (!insideEpisode(i)) ambientFrames.push(i);
    }
  }
  const ambientShare = validDts.length ? ambientFrames.length / validDts.length : 0;
  if (ambientShare >= 0.1) {
    let worstIdx = ambientFrames[0];
    let sumExcessMs = 0;
    for (const i of ambientFrames) {
      sumExcessMs += dts[i] - stableDtMs;
      if (dts[i] > dts[worstIdx]) worstIdx = i;
    }
    episodes.unshift({
      frames: ambientFrames,
      startMs: 0,
      endMs: model.durationMs,
      durationMs: model.durationMs,
      worstIdx,
      sumExcessMs,
      kind: "ambient",
      label: `фоновая неровность · ${Math.round(ambientShare * 100)}% кадров по ${Math.round(goodThresholdMs)}–${Math.round(badThresholdMs)} мс`,
      avgFps: 1000 / (validDts.reduce((a, b) => a + b, 0) / validDts.length),
      verdictTitle: "",
      verdictParts: [],
      flags: [],
      deviations: []
    });
  }

  // --- per-episode baseline diff and verdict ---
  const sessionStable: number[] = [];
  for (let i = 0; i < n; i++) {
    if (dts[i] <= GAP_MS && dts[i] <= goodThresholdMs) sessionStable.push(i);
  }

  for (const ep of episodes) {
    // Short dips are compared against their untouched neighborhood. A long
    // uneven stretch is compared against the good frames INSIDE it — the
    // neighborhood there is a different game state (menu, other location)
    // and the diff would explain the location, not the jank.
    const longEpisode = ep.durationMs > 8000;
    let baseSet: number[] = [];
    for (const i of sessionStable) {
      const end = ends[i];
      if (end < ep.startMs - NEAR_MS || end > ep.endMs + NEAR_MS) continue;
      if (!longEpisode && end > ep.startMs && end - dts[i] < ep.endMs) continue;
      baseSet.push(i);
    }
    if (baseSet.length < 40) baseSet = sessionStable;

    for (const def of defs) {
      const metric = metrics.get(def.key)!;
      const baseValues = collectValid(metric, baseSet);
      const value = meanValid(metric, ep.frames);
      if (!baseValues.length || Number.isNaN(value)) continue;
      const base = median(baseValues);
      if (def.fmt === "mb") {
        // level metric: an absolute jump matters, a ratio does not
        if (Math.abs(value - base) >= 25) {
          ep.deviations.push({ def, base, value, ratio: value / base, score: (value - base) / 25 });
        }
        continue;
      }
      const deviationsAbs = baseValues.map(v => Math.abs(v - base));
      const mad = median(deviationsAbs);
      const eps = def.fmt === "ms" ? 0.3 : 0.3;
      const floor = def.fmt === "ms" ? 0.5 : Math.max(0.6, base * 0.04);
      const score = (value - base) / Math.max(mad * 1.4826, floor);
      if (base <= eps) {
        // appeared from (near) zero
        const newFloor = def.fmt === "ms" ? 2 : 1;
        if (value >= newFloor) ep.deviations.push({ def, base, value, ratio: Infinity, score });
        continue;
      }
      const ratio = value / base;
      if (Math.abs(score) >= 3 && (ratio >= 1.25 || ratio <= 0.8)) {
        ep.deviations.push({ def, base, value, ratio, score });
      }
    }
    ep.deviations.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    ep.deviations = ep.deviations.slice(0, 10);

    // verdict: where the frame time went, on average over the slow frames
    const mDt = meanValid(dts, ep.frames);
    const mMain = meanValid(mainMs, ep.frames);
    const mGpu = meanValid(gpuMs, ep.frames);
    const mStall = meanValid(stallMs, ep.frames);
    const mRec = meanValid(recMs, ep.frames);
    const mScript = meanValid(scriptMs, ep.frames);
    const mRender = meanValid(renderCpuMs, ep.frames);
    const mGc = meanValid(gcMs, ep.frames);
    const idle = Math.max(mDt - mMain, 0);

    ep.verdictParts = [
      `кадр в среднем ${formatMs(mDt)}`,
      `главный поток занят ${formatMs(mMain)}`,
      `ожидание GPU ${formatMs(mGpu)}`
    ];
    if (mStall > 0.5) ep.verdictParts.push(`столлы ${formatMs(mStall)}`);
    if (mRec > 0.5) ep.verdictParts.push(`запись экрана ${formatMs(mRec)}`);

    if (hasGpu && mGpu >= idle * 0.7 && idle >= mDt * 0.4) {
      ep.verdictTitle =
        "GPU-зависимый: главный поток простаивает — кадр ждёт видеокарту/композитор. Смотрите отклонения рендер-счётчиков.";
    } else if (mMain >= mDt * 0.55) {
      // Stalls overlap the instrumented work (a long tick blocks the
      // heartbeat too), so pick the dominant *named* cause first and treat
      // stall time as the cause only when the named work doesn't cover it.
      const contributors: [string, number][] = [
        ["скрипты AVM", mScript],
        ["рендер на CPU", mRender],
        ["сборка мусора", mGc],
        ["запись экрана", mRec]
      ];
      contributors.sort((a, b) => b[1] - a[1]);
      const named = mScript + mRender + mGc + mRec;
      const unnamed = Math.max(0, mMain - named);
      if (unnamed > Math.max(contributors[0][1], mDt * 0.25)) {
        ep.verdictTitle = `CPU-зависимый: главный поток занят, но ~${formatMs(unnamed)}/кадр — вне записанных событий (неинструментированный JS/WebKit; столлы ${formatMs(mStall)}).`;
      } else {
        ep.verdictTitle = `CPU-зависимый: кадр занят работой на главном потоке, больше всего — ${contributors[0][0]} (${formatMs(contributors[0][1])}/кадр).`;
      }
    } else if (mStall >= mDt * 0.25) {
      ep.verdictTitle = `Главный поток блокируется вне записанных событий (столлы ${formatMs(mStall)}/кадр) — неинструментированный JS или WebKit.`;
    } else if (!hasGpu) {
      ep.verdictTitle =
        "Главный поток свободен, а куда ушло время — не видно: профиль записан сборкой без GPU-датчика.";
    } else {
      ep.verdictTitle =
        "Смешанный: явного одного виновника нет — главный поток занят лишь частично, GPU-метка не покрывает простой.";
    }

    // context flags — only meaningful for localized episodes
    if (ep.kind !== "ambient") {
      let netTotal = 0;
      for (let i = ep.frames[0]; i <= ep.frames[ep.frames.length - 1]; i++) netTotal += netEvents[i];
      if (netTotal >= 5) ep.flags.push(`на фоне загрузок: ${Math.round(netTotal)} сетевых событий внутри эпизода`);
      const before = markers.filter(m => m.tsMs <= ep.startMs && ep.startMs - m.tsMs <= 30000).pop();
      if (before) {
        ep.flags.push(`через ${((ep.startMs - before.tsMs) / 1000).toFixed(1)} с после маркера ${before.name}`);
      }
      const inside = markers.find(m => m.tsMs > ep.startMs && m.tsMs < ep.endMs);
      if (inside) ep.flags.push(`маркер ${inside.name} внутри эпизода`);
    }
  }

  return { stableDtMs, goodThresholdMs, badThresholdMs, episodes, hasCounters, hasGpu };
}

// ---------------------------------------------------------------------------
// rendering

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtValue(def: MetricDef, value: number): string {
  if (def.fmt === "ms") return value < 0.05 ? "0" : formatMs(value);
  if (def.fmt === "mb") return `${value.toFixed(0)} МБ`;
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

export function renderEpisodesTab(
  container: HTMLElement,
  model: ProfileModel,
  diag: Diagnosis,
  onFrame: (frameIndex: number) => void,
  onSpan: (startMs: number, endMs: number) => void
) {
  container.textContent = "";
  if (!model.frameTimesMs.length) {
    container.appendChild(el("div", "details-empty", "В профиле нет кадров."));
    return;
  }
  if (!diag.episodes.length) {
    container.appendChild(
      el(
        "div",
        "details-empty",
        `Отклонений от стабильного фреймрейта (кадр ${formatMs(diag.stableDtMs)}, порог ${formatMs(diag.badThresholdMs)}) не найдено — ровная сессия.`
      )
    );
    return;
  }

  const localized = diag.episodes.filter(ep => ep.kind !== "ambient");
  const inEpisodesMs = localized.reduce((sum, ep) => sum + ep.durationMs, 0);
  const share = Math.min((inEpisodesMs / model.durationMs) * 100, 100);
  container.appendChild(
    el(
      "div",
      "frame-summary",
      `типичный кадр ${formatMs(diag.stableDtMs)} (${(1000 / diag.stableDtMs).toFixed(0)} к/с) · ` +
        `норма ≤${Math.round(diag.goodThresholdMs)} мс · порог эпизода ${Math.round(diag.badThresholdMs)} мс · ` +
        `эпизодов: ${localized.length} (${share.toFixed(0)}% времени сессии)`
    )
  );

  const chips = el("div", "ep-chips");
  container.appendChild(chips);
  const card = el("div", "ep-card");
  container.appendChild(card);

  const chipButtons: HTMLElement[] = [];

  const renderCard = (index: number) => {
    chipButtons.forEach((chip, i) => chip.classList.toggle("active", i === index));
    const ep = diag.episodes[index];
    card.textContent = "";

    const header = el("div", "details-header");
    const chip = el("span", "sev-chip");
    chip.style.background = severityColor(model.frameDtMs[ep.worstIdx]);
    header.appendChild(chip);
    header.appendChild(el("span", "details-name", ` @${formatClock(ep.startMs)} · ${ep.label}`));
    header.appendChild(
      el("span", "dim", ` · медленных кадров: ${ep.frames.length} · худший ${formatMs(model.frameDtMs[ep.worstIdx])}`)
    );
    card.appendChild(header);

    card.appendChild(el("div", "ep-verdict", ep.verdictTitle));
    const parts = el("div", "frame-summary");
    for (const part of ep.verdictParts) parts.appendChild(el("span", "frame-summary-item", part));
    card.appendChild(parts);
    for (const flag of ep.flags) card.appendChild(el("div", "ep-flag", `⌖ ${flag}`));

    card.appendChild(el("div", "ep-section-title", "Что отличается от нормы в медленных кадрах:"));
    if (ep.deviations.length) {
      const table = el("table", "grid") as HTMLTableElement;
      const head = table.createTHead().insertRow();
      for (const title of ["метрика", "норма рядом", "в эпизоде", "отклонение"]) {
        head.appendChild(el("th", "", title));
      }
      const body = table.createTBody();
      for (const dev of ep.deviations) {
        const tr = body.insertRow();
        tr.insertCell().textContent = dev.def.label;
        tr.insertCell().textContent = fmtValue(dev.def, dev.base);
        tr.insertCell().textContent = fmtValue(dev.def, dev.value);
        const cell = tr.insertCell();
        if (dev.def.fmt === "mb") {
          const delta = dev.value - dev.base;
          cell.appendChild(
            el("span", delta > 0 ? "dev-up" : "dev-down", `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)} МБ`)
          );
        } else if (dev.ratio === Infinity) {
          cell.appendChild(el("span", "dev-new", "появилось"));
        } else {
          cell.appendChild(
            el("span", dev.ratio > 1 ? "dev-up" : "dev-down", `×${dev.ratio.toFixed(1)}`)
          );
        }
      }
      card.appendChild(table);
    } else {
      card.appendChild(
        el(
          "div",
          "dim",
          "Значимых отличий в записанных метриках нет — причина вне того, что мы меряем покадрово."
        )
      );
    }
    if (!diag.hasCounters) {
      card.appendChild(
        el(
          "div",
          "dim",
          "Профиль без рендер-счётчиков (нужна инструментированная сборка Ruffle) — состав рендера сравнить не с чем."
        )
      );
    }

    const worst = [...ep.frames].sort((a, b) => model.frameDtMs[b] - model.frameDtMs[a]).slice(0, 5);
    const worstRow = el("div", "ep-chips");
    worstRow.appendChild(el("span", "ep-section-title", "Худшие кадры:"));
    for (const frameIndex of worst) {
      const button = el("button", "ep-chip");
      const dot = el("span", "sev-chip");
      dot.style.background = severityColor(model.frameDtMs[frameIndex]);
      button.appendChild(dot);
      button.appendChild(
        document.createTextNode(
          ` ${formatClock(model.frameTimesMs[frameIndex] - model.frameDtMs[frameIndex])} · ${formatMs(model.frameDtMs[frameIndex])}`
        )
      );
      button.addEventListener("click", () => onFrame(frameIndex));
      worstRow.appendChild(button);
    }
    card.appendChild(worstRow);
  };

  diag.episodes.forEach((ep, index) => {
    const button = el("button", "ep-chip");
    const dot = el("span", "sev-chip");
    dot.style.background = severityColor(model.frameDtMs[ep.worstIdx]);
    button.appendChild(dot);
    button.appendChild(document.createTextNode(` ${formatClock(ep.startMs)} · ${ep.label}`));
    button.addEventListener("click", () => {
      renderCard(index);
      onSpan(ep.startMs, ep.endMs);
    });
    chips.appendChild(button);
    chipButtons.push(button);
  });

  // preselect the heaviest episode without touching the viewport
  let heaviest = 0;
  diag.episodes.forEach((ep, index) => {
    if (ep.sumExcessMs > diag.episodes[heaviest].sumExcessMs) heaviest = index;
  });
  renderCard(heaviest);
}
