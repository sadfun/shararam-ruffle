// The Frame Timeline — Scout's main panel. One canvas stacks the ruler, the
// Frame Time chart (grey bars = full frame time, colored stack = active time
// by category, red line = frame budget), the Memory chart and the event
// tracks. Click-drag selects a frame range; the selection drives every other
// panel. Wheel zooms, the bottom scrollbar pans.
//
// Scout draws every frame the same width; we keep the bars on the real time
// axis instead so they line up with the session strip and the recording.

import { ProfileModel, formatClock, formatMs } from "./model";
import { FrameData, TRACK_LABELS, TRACK_ICONS } from "./frameData";
import { ScoutState } from "./state";
import { Viewport, prepareCanvas, lowerBound, tickStepMs } from "./view";
import { CATEGORIES, BUDGET_COLOR, SELECT_COLOR } from "./categories";

export const LEFT_GUTTER = 78;
const RULER_H = 20;
const FRAME_H = 140;
const MEMORY_H = 56;
const CPU_H = 48;
const TRACK_H = 15;
const SCROLL_H = 12;
const GAP_MS = 500;

/** process key → display label + line color for the CPU chart */
const CPU_SERIES: [string, string, string][] = [
  ["webcontent", "страница", "#e8c95a"],
  ["gpu", "gpu-процесс", "#c084e0"],
  ["client", "клиент", "#9a9c9a"]
];

export class FrameTimeline {
  showMemory = true;
  showCpu = true;
  showEvents = true;
  private yMax: number;
  private dragStartMs: number | null = null;
  private dragMoved = false;
  private scrollDrag: { x: number; v0: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState,
    private describeTooltip: (clientX: number, clientY: number, text: string) => void,
    private hideTooltip: () => void
  ) {
    // fixed vertical scale: budget must sit at a stable height while zooming
    const sorted = [...model.frameDtMs].filter(dt => dt <= GAP_MS).sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 100;
    this.yMax = Math.min(Math.max(p99 * 1.4, (1000 / state.targetFps) * 2.5), 350);
    this.attach();
  }

  private cpuOn(): boolean {
    return this.showCpu && this.data.cpu.size > 0;
  }

  preferredHeight(): number {
    return (
      RULER_H +
      FRAME_H +
      (this.showMemory ? MEMORY_H : 0) +
      (this.cpuOn() ? CPU_H : 0) +
      (this.showEvents ? TRACK_H * TRACK_LABELS.length : 0) +
      SCROLL_H +
      6
    );
  }

  frameIndexAt(ms: number): number {
    const times = this.model.frameTimesMs;
    const index = lowerBound(times, ms);
    if (index >= times.length) return -1;
    if (times[index] - this.model.frameDtMs[index] > ms) return -1;
    return index;
  }

  /** nearest frame, for clicks that land in a gap */
  private nearestFrame(ms: number): number {
    const times = this.model.frameTimesMs;
    if (!times.length) return -1;
    const exact = this.frameIndexAt(ms);
    if (exact >= 0) return exact;
    const index = lowerBound(times, ms);
    if (index <= 0) return 0;
    if (index >= times.length) return times.length - 1;
    return ms - times[index - 1] < times[index] - this.model.frameDtMs[index] - ms
      ? index - 1
      : index;
  }

  frameSpan(index: number): [number, number] {
    const end = this.model.frameTimesMs[index];
    return [end - Math.min(this.model.frameDtMs[index], GAP_MS), end];
  }

  private msAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return this.viewport.msOf(clientX - rect.left - LEFT_GUTTER, rect.width - LEFT_GUTTER);
  }

  private attach() {
    const canvas = this.canvas;
    canvas.addEventListener(
      "wheel",
      event => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const width = rect.width - LEFT_GUTTER;
        const x = event.clientX - rect.left - LEFT_GUTTER;
        if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
          this.viewport.zoomAround(this.viewport.msOf(Math.max(x, 0), width), Math.pow(1.0018, event.deltaY));
        } else {
          this.viewport.panByMs((event.deltaX / width) * this.viewport.span());
        }
      },
      { passive: false }
    );

    canvas.addEventListener("pointerdown", event => {
      const rect = canvas.getBoundingClientRect();
      const y = event.clientY - rect.top;
      if (y >= rect.height - SCROLL_H) {
        this.scrollDrag = { x: event.clientX, v0: this.viewport.v0 };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      this.dragStartMs = this.msAt(event.clientX);
      this.dragMoved = false;
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener("pointermove", event => {
      if (this.scrollDrag) {
        const rect = canvas.getBoundingClientRect();
        const scale = this.viewport.totalMs / (rect.width - LEFT_GUTTER);
        const v0 = this.scrollDrag.v0 + (event.clientX - this.scrollDrag.x) * scale;
        this.viewport.setRange(v0, v0 + this.viewport.span());
        return;
      }
      const ms = this.msAt(event.clientX);
      if (this.dragStartMs !== null) {
        if (Math.abs(ms - this.dragStartMs) > this.viewport.span() / 400) this.dragMoved = true;
        if (this.dragMoved) {
          const a = this.nearestFrame(Math.min(this.dragStartMs, ms));
          const b = this.nearestFrame(Math.max(this.dragStartMs, ms));
          if (a >= 0 && b >= 0) this.state.setSelection({ a, b });
        }
        return;
      }
      this.state.setHover(ms);
      const index = this.frameIndexAt(ms);
      if (index >= 0) this.describeTooltip(event.clientX, event.clientY, this.describe(index));
      else this.hideTooltip();
    });

    canvas.addEventListener("pointerup", event => {
      if (this.scrollDrag) {
        this.scrollDrag = null;
        return;
      }
      if (this.dragStartMs !== null && !this.dragMoved) {
        const index = this.nearestFrame(this.msAt(event.clientX));
        if (index >= 0) this.state.setSelection({ a: index, b: index });
      }
      this.dragStartMs = null;
    });

    canvas.addEventListener("pointerleave", () => {
      this.state.setHover(null);
      this.hideTooltip();
    });
  }

  describe(index: number): string {
    const dt = this.model.frameDtMs[index];
    const parts = [
      `кадр @${formatClock(this.model.frameTimesMs[index] - dt)} · ${formatMs(dt)} (${(1000 / dt).toFixed(1)} fps)`,
      `активен ${formatMs(this.data.activeMs[index])}`
    ];
    CATEGORIES.forEach((category, cat) => {
      const ms = this.data.catMs[cat][index];
      if (ms >= 0.5) parts.push(`${category.label} ${formatMs(ms)}`);
    });
    if (this.data.gpuWaitMs[index] >= 1) parts.push(`ожидание GPU ${formatMs(this.data.gpuWaitMs[index])}`);
    if (this.data.stallMs[index] >= 1) {
      const outMs = this.data.stallMs[index] - this.data.stallInTickMs[index];
      parts.push(
        `блокировка ${formatMs(this.data.stallMs[index])}` +
          (outMs >= 0.5 ? ` (вне тика ${formatMs(outMs)})` : "")
      );
    }
    if (!Number.isNaN(this.data.gcHeapMb[index]))
      parts.push(`куча gc ${this.data.gcHeapMb[index].toFixed(1)} МБ`);
    const objects = this.data.counters.get("avm1_objects");
    if (objects && objects[index] > 0) parts.push(`аллокаций AVM1 ${objects[index]}`);
    if (this.data.cpu.size) {
      const cpuParts = CPU_SERIES.filter(([key]) => this.data.cpu.has(key))
        .map(([key, label]) => {
          const pct = this.data.cpu.get(key)![index];
          return Number.isNaN(pct) ? null : `${label} ${Math.round(pct)}%`;
        })
        .filter(Boolean);
      if (cpuParts.length) parts.push(`CPU: ${cpuParts.join(" · ")}`);
    }
    return parts.join("\n");
  }

  draw() {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const plotWidth = Math.max(Math.floor(width - LEFT_GUTTER), 1);
    const viewport = this.viewport;
    const times = this.model.frameTimesMs;
    const dts = this.model.frameDtMs;
    const selection = this.state.selection;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#333533";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "10px ui-monospace, Menlo, monospace";

    const from = Math.max(lowerBound(times, viewport.v0) - 1, 0);
    const to = Math.min(lowerBound(times, viewport.v1 + GAP_MS) + 1, times.length);

    // ---- ruler -----------------------------------------------------------
    ctx.fillStyle = "#2b2d2b";
    ctx.fillRect(0, 0, width, RULER_H);
    const step = tickStepMs(viewport.span(), Math.max(plotWidth / 90, 2));
    ctx.fillStyle = "#9a9c9a";
    ctx.strokeStyle = "#454745";
    for (let t = Math.ceil(viewport.v0 / step) * step; t <= viewport.v1; t += step) {
      const x = LEFT_GUTTER + viewport.xOf(t, plotWidth);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 5);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      const label = step >= 1000 ? formatClock(t).replace(/\.\d+$/, "") : formatClock(t);
      ctx.fillText(label, x + 3, RULER_H - 7);
    }

    // ---- chart areas -----------------------------------------------------
    const frameTop = RULER_H;
    const frameBottom = frameTop + FRAME_H;
    const memoryTop = frameBottom + 1;
    const memoryBottom = memoryTop + (this.showMemory ? MEMORY_H : 0);
    const cpuOn = this.cpuOn();
    const cpuTop = memoryBottom + 1;
    const cpuBottom = cpuTop + (cpuOn ? CPU_H : 0);
    const tracksTop = cpuBottom + 1;

    ctx.fillStyle = "#232523";
    ctx.fillRect(LEFT_GUTTER, frameTop, plotWidth, FRAME_H);
    if (this.showMemory) ctx.fillRect(LEFT_GUTTER, memoryTop, plotWidth, MEMORY_H);
    if (cpuOn) ctx.fillRect(LEFT_GUTTER, cpuTop, plotWidth, CPU_H);

    // gutter labels
    ctx.fillStyle = "#8f918f";
    ctx.fillText("Время кадра", 6, frameTop + 12);
    ctx.fillText(`${Math.round(this.yMax)} мс`, 6, frameTop + 24);
    if (this.showMemory) {
      ctx.fillText("Память", 6, memoryTop + 12);
      ctx.fillText(
        `${Math.round(Math.max(this.data.memoryMaxMb, this.data.gcHeapMaxMb))} МБ`,
        6,
        memoryTop + 24
      );
      if (this.data.gcHeapMaxMb > 0) {
        ctx.fillStyle = "#7fd4de";
        ctx.fillText("— куча gc", 6, memoryTop + 36);
        ctx.fillStyle = "#8f918f";
      }
    }

    const yOf = (ms: number) =>
      frameBottom - Math.min(ms / this.yMax, 1.04) * (FRAME_H - 8);

    // selection backdrop across all charts
    if (selection) {
      const [s0] = this.frameSpan(selection.a);
      const s1 = times[selection.b];
      const x0 = Math.max(LEFT_GUTTER + viewport.xOf(s0, plotWidth), LEFT_GUTTER);
      const x1 = Math.min(LEFT_GUTTER + viewport.xOf(s1, plotWidth), width);
      if (x1 > x0) {
        ctx.fillStyle = "rgba(33, 158, 222, 0.13)";
        ctx.fillRect(x0, frameTop, x1 - x0, (this.showEvents ? tracksTop + TRACK_H * TRACK_LABELS.length : cpuBottom) - frameTop);
      }
    }

    // ---- frame bars ------------------------------------------------------
    const filter = this.state.categoryFilter;
    const avgWidth = plotWidth / Math.max(to - from, 1);
    const barMode = avgWidth >= 3;

    const drawBar = (x0: number, x1: number, dt: number, cats: number[], selected: boolean) => {
      const w = Math.max(x1 - x0, 1);
      ctx.fillStyle = selected ? "#5a6a74" : "#4a4d4a";
      const topY = yOf(dt);
      ctx.fillRect(x0, topY, w, frameBottom - topY);
      let y = frameBottom;
      CATEGORIES.forEach((category, cat) => {
        const ms = cats[cat];
        if (ms <= 0) return;
        const h = (Math.min(ms, this.yMax) / this.yMax) * (FRAME_H - 8);
        if (filter === null || filter === cat) {
          ctx.fillStyle = category.color;
          ctx.fillRect(x0, y - h, w, h);
        }
        y -= h;
      });
    };

    if (barMode) {
      for (let i = from; i < to; i++) {
        const [s0, s1] = this.frameSpan(i);
        const x0 = LEFT_GUTTER + viewport.xOf(s0, plotWidth);
        const x1 = LEFT_GUTTER + viewport.xOf(s1, plotWidth);
        if (x1 < LEFT_GUTTER || x0 > width) continue;
        const selected = !!selection && i >= selection.a && i <= selection.b;
        drawBar(
          Math.max(x0, LEFT_GUTTER) + 0.5,
          Math.max(x1 - (avgWidth > 5 ? 1 : 0), x0 + 1),
          Math.min(dts[i], GAP_MS),
          CATEGORIES.map((_c, cat) => this.data.catMs[cat][i]),
          selected
        );
      }
    } else {
      // zoomed out: each pixel shows its worst frame, so spikes stay visible
      let pixel = -1;
      let worst = -1;
      for (let i = from; i < to; i++) {
        const x = Math.floor(viewport.xOf(times[i], plotWidth));
        if (x < 0 || x >= plotWidth) continue;
        if (x !== pixel) {
          if (worst >= 0)
            drawBar(
              LEFT_GUTTER + pixel,
              LEFT_GUTTER + pixel + 1,
              Math.min(dts[worst], GAP_MS),
              CATEGORIES.map((_c, cat) => this.data.catMs[cat][worst]),
              !!selection && worst >= selection.a && worst <= selection.b
            );
          pixel = x;
          worst = i;
        } else if (dts[i] > dts[worst]) worst = i;
      }
      if (worst >= 0)
        drawBar(
          LEFT_GUTTER + pixel,
          LEFT_GUTTER + pixel + 1,
          Math.min(dts[worst], GAP_MS),
          CATEGORIES.map((_c, cat) => this.data.catMs[cat][worst]),
          !!selection && worst >= selection.a && worst <= selection.b
        );
    }

    // budget line
    const budgetY = yOf(this.state.budgetMs());
    ctx.strokeStyle = BUDGET_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(LEFT_GUTTER, budgetY);
    ctx.lineTo(width, budgetY);
    ctx.stroke();
    ctx.lineWidth = 1;

    // ---- memory ----------------------------------------------------------
    // wasm memory as teal bars; the gc-arena heap (when recorded) as a
    // lighter line on the same MB scale, so growth is directly comparable
    const memoryScaleMb = Math.max(this.data.memoryMaxMb, this.data.gcHeapMaxMb);
    if (this.showMemory && memoryScaleMb > 0) {
      ctx.fillStyle = "#108a94";
      for (let i = from; i < to; i++) {
        const mb = this.data.memoryMb[i];
        if (Number.isNaN(mb)) continue;
        const [s0, s1] = this.frameSpan(i);
        const x0 = Math.max(LEFT_GUTTER + viewport.xOf(s0, plotWidth), LEFT_GUTTER);
        const x1 = LEFT_GUTTER + viewport.xOf(s1, plotWidth);
        if (x1 < LEFT_GUTTER || x0 > width) continue;
        const h = (mb / memoryScaleMb) * (MEMORY_H - 8);
        ctx.fillRect(x0, memoryBottom - h, Math.max(x1 - x0, 1), h);
      }
      if (this.data.gcHeapMaxMb > 0) {
        ctx.strokeStyle = "#7fd4de";
        ctx.beginPath();
        let started = false;
        for (let i = from; i < to; i++) {
          const mb = this.data.gcHeapMb[i];
          if (Number.isNaN(mb)) continue;
          const x = LEFT_GUTTER + viewport.xOf(times[i], plotWidth);
          if (x < LEFT_GUTTER || x > width) continue;
          const y = memoryBottom - (mb / memoryScaleMb) * (MEMORY_H - 8);
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
        ctx.stroke();
      }
    }

    // ---- process CPU -----------------------------------------------------
    if (cpuOn) {
      const yMax = Math.max(Math.ceil(this.data.cpuMax / 50) * 50, 100);
      ctx.fillStyle = "#8f918f";
      ctx.fillText(`CPU ${yMax} %`, 6, cpuTop + 10);
      let legendY = cpuTop + 22;
      for (const [key, label, color] of CPU_SERIES) {
        if (!this.data.cpu.has(key)) continue;
        ctx.fillStyle = color;
        ctx.fillText(`— ${label}`, 6, legendY);
        legendY += 11;
      }
      for (const [key, , color] of CPU_SERIES) {
        const series = this.data.cpu.get(key);
        if (!series) continue;
        ctx.strokeStyle = color;
        ctx.beginPath();
        let started = false;
        for (let i = from; i < to; i++) {
          const pct = series[i];
          if (Number.isNaN(pct)) continue;
          const x = LEFT_GUTTER + viewport.xOf(times[i], plotWidth);
          if (x < LEFT_GUTTER || x > width) continue;
          const y = cpuBottom - 2 - (Math.min(pct, yMax) / yMax) * (CPU_H - 6);
          if (started) ctx.lineTo(x, y);
          else {
            ctx.moveTo(x, y);
            started = true;
          }
        }
        ctx.stroke();
      }
    }

    // ---- event tracks ----------------------------------------------------
    if (this.showEvents) {
      TRACK_LABELS.forEach((label, track) => {
        const y0 = tracksTop + track * TRACK_H;
        ctx.fillStyle = track % 2 ? "#232523" : "#262826";
        ctx.fillRect(LEFT_GUTTER, y0, plotWidth, TRACK_H);
        ctx.fillStyle = "#8f918f";
        ctx.fillText(`${TRACK_ICONS[track]} ${label}`, 6, y0 + 11);
        ctx.fillStyle = "#3987e5";
        const counts = this.data.tracks[track];
        for (let i = from; i < to; i++) {
          if (!counts[i]) continue;
          const [s0, s1] = this.frameSpan(i);
          const x0 = Math.max(LEFT_GUTTER + viewport.xOf(s0, plotWidth), LEFT_GUTTER);
          const x1 = LEFT_GUTTER + viewport.xOf(s1, plotWidth);
          if (x1 < LEFT_GUTTER || x0 > width) continue;
          const h = Math.min(3 + Math.log2(1 + counts[i]) * 3, TRACK_H - 3);
          ctx.fillRect(x0, y0 + TRACK_H - 1 - h, Math.max(x1 - x0, 1), h);
        }
      });
    }

    // ---- selection brackets on the ruler + playhead ----------------------
    if (selection) {
      const [s0] = this.frameSpan(selection.a);
      const s1 = times[selection.b];
      for (const ms of [s0, s1]) {
        const x = LEFT_GUTTER + viewport.xOf(ms, plotWidth);
        if (x < LEFT_GUTTER || x > width) continue;
        ctx.fillStyle = "#d8dadc";
        ctx.fillRect(x - 2, 2, 4, RULER_H - 4);
      }
    }
    if (this.state.hoverMs !== null) {
      const x = Math.round(LEFT_GUTTER + viewport.xOf(this.state.hoverMs, plotWidth)) + 0.5;
      if (x >= LEFT_GUTTER && x <= width) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - 4);
        ctx.lineTo(x, height - SCROLL_H);
        ctx.stroke();
      }
    }

    // ---- scrollbar -------------------------------------------------------
    const scrollTop = height - SCROLL_H;
    ctx.fillStyle = "#2a2c2a";
    ctx.fillRect(LEFT_GUTTER, scrollTop, plotWidth, SCROLL_H);
    const t0 = Math.max(viewport.v0 / viewport.totalMs, 0);
    const t1 = Math.min(viewport.v1 / viewport.totalMs, 1);
    ctx.fillStyle = "#5a5d5a";
    ctx.fillRect(
      LEFT_GUTTER + t0 * plotWidth,
      scrollTop + 2,
      Math.max((t1 - t0) * plotWidth, 8),
      SCROLL_H - 4
    );
  }
}
