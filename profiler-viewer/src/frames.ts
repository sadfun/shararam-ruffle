// The frame strip: every animation frame as a column on the time axis,
// height and color by frame time. This is the "where is it slow" ruler —
// zoomed out, each pixel shows the worst frame it covers, so spikes stay
// visible at any scale.

import { ProfileModel, formatMs, formatClock } from "./model";
import { Viewport, prepareCanvas, lowerBound } from "./view";
import { LEFT_GUTTER } from "./fps";

/** Frame-time cap of the strip's y-scale; taller frames clip at full height. */
const CAP_MS = 80;
const GAP_THRESHOLD_MS = 500;

/** Severity steps share the palette of the lanes/fps charts. */
export function severityColor(dtMs: number): string {
  if (dtMs <= 20) return "#199e70";
  if (dtMs <= 36) return "#c98500";
  if (dtMs <= 60) return "#d95926";
  return "#e66767";
}

export class FrameStrip {
  /** index into model.frameTimesMs, -1 = none */
  selectedIndex = -1;
  hoveredIndex = -1;
  /** shared scrub cursor (profile ms), drawn as a vertical line */
  cursorMs: number | null = null;
  /** representative (worst) frame per canvas pixel, for hit-testing */
  private pixelFrame = new Int32Array(0);

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private model: ProfileModel
  ) {}

  /** [startMs, endMs] of frame `index` on the profile timeline. */
  frameSpan(index: number): [number, number] {
    const end = this.model.frameTimesMs[index];
    return [end - this.model.frameDtMs[index], end];
  }

  hitFrame(x: number): number {
    const px = Math.floor(x - LEFT_GUTTER);
    if (px < 0 || px >= this.pixelFrame.length) return -1;
    return this.pixelFrame[px];
  }

  describe(index: number): string {
    const dt = this.model.frameDtMs[index];
    const [start] = this.frameSpan(index);
    return `кадр ${formatMs(dt)} (${(1000 / dt).toFixed(0)} fps) · @${formatClock(start)}`;
  }

  draw() {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const plotWidth = Math.max(Math.floor(width - LEFT_GUTTER), 1);
    const viewport = this.viewport;
    const model = this.model;
    const times = model.frameTimesMs;
    const dts = model.frameDtMs;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#141517";
    ctx.fillRect(0, 0, width, height);

    const plotBottom = height - 4;
    const plotHeight = plotBottom - 4;
    const heightOf = (dt: number) => Math.max((Math.min(dt, CAP_MS) / CAP_MS) * plotHeight, 1.5);

    if (this.pixelFrame.length !== plotWidth) this.pixelFrame = new Int32Array(plotWidth);
    this.pixelFrame.fill(-1);

    // reference lines: 16.7ms (60 Hz) and 40ms (25 fps budget)
    ctx.strokeStyle = "#26282c";
    ctx.setLineDash([3, 4]);
    ctx.font = "9px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#7d7f83";
    for (const [ms, label] of [[16.7, "16.7"], [40, "40ms"]] as const) {
      const y = Math.round(plotBottom - heightOf(ms)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(LEFT_GUTTER, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(String(label), LEFT_GUTTER - 30, y + 3);
    }
    ctx.setLineDash([]);

    if (times.length) {
      const from = Math.max(lowerBound(times, viewport.v0) - 1, 0);
      const to = Math.min(lowerBound(times, viewport.v1 + GAP_THRESHOLD_MS) + 1, times.length);
      const pxPerFrame = plotWidth / Math.max((to - from), 1);
      const aggregated = pxPerFrame < 2.5;

      for (let i = from; i < to; i++) {
        const dt = dts[i];
        const end = times[i];
        if (dt > GAP_THRESHOLD_MS) {
          // no animation frames (hidden page / giant stall): gray block
          const x0 = LEFT_GUTTER + viewport.xOf(end - dt, plotWidth);
          const x1 = LEFT_GUTTER + viewport.xOf(end, plotWidth);
          ctx.fillStyle = "rgba(122, 125, 131, 0.16)";
          ctx.fillRect(Math.max(x0, LEFT_GUTTER), 4, Math.max(x1 - x0, 1), plotHeight);
          continue;
        }
        const x0 = viewport.xOf(end - dt, plotWidth);
        const x1 = viewport.xOf(end, plotWidth);
        if (x1 < 0 || x0 > plotWidth) continue;
        const p0 = Math.max(Math.floor(x0), 0);
        const p1 = Math.min(Math.max(Math.ceil(x1), p0 + 1), plotWidth);
        // hit-test map: the worst frame owns the pixel
        for (let px = p0; px < p1; px++) {
          const owner = this.pixelFrame[px];
          if (owner < 0 || dts[owner] < dt) this.pixelFrame[px] = i;
        }
        if (aggregated) continue; // drawn from the pixel map below
        const barHeight = heightOf(dt);
        const gap = x1 - x0 >= 3 ? 0.5 : 0;
        ctx.fillStyle = severityColor(dt);
        ctx.globalAlpha = i === this.hoveredIndex ? 1 : 0.88;
        ctx.fillRect(LEFT_GUTTER + x0 + gap, plotBottom - barHeight, x1 - x0 - gap * 2, barHeight);
        ctx.globalAlpha = 1;
      }

      if (aggregated) {
        // per-pixel columns: worst frame in each pixel
        for (let px = 0; px < plotWidth; px++) {
          const index = this.pixelFrame[px];
          if (index < 0) continue;
          const dt = dts[index];
          const barHeight = heightOf(dt);
          ctx.fillStyle = severityColor(dt);
          ctx.fillRect(LEFT_GUTTER + px, plotBottom - barHeight, 1, barHeight);
        }
      }

      // selection highlight
      if (this.selectedIndex >= 0) {
        const [start, end] = this.frameSpan(this.selectedIndex);
        const x0 = LEFT_GUTTER + viewport.xOf(start, plotWidth);
        const x1 = LEFT_GUTTER + viewport.xOf(end, plotWidth);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, 2.5, Math.max(x1 - x0 - 1, 1.5), height - 5);
      }
    }

    // scrub cursor
    if (this.cursorMs !== null) {
      const x = Math.round(LEFT_GUTTER + viewport.xOf(this.cursorMs, plotWidth)) + 0.5;
      if (x >= LEFT_GUTTER && x <= width) {
        ctx.strokeStyle = "rgba(232, 233, 235, 0.45)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }

    ctx.fillStyle = "#7d7f83";
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillText("кадры", 8, 14);
  }

  /**
   * Indices of frames slower than `thresholdMs` (gaps excluded), in time
   * order — the prev/next navigation walks this list.
   */
  slowFrames(thresholdMs: number): number[] {
    const result: number[] = [];
    const dts = this.model.frameDtMs;
    for (let i = 0; i < dts.length; i++) {
      if (dts[i] > thresholdMs && dts[i] <= GAP_THRESHOLD_MS) result.push(i);
    }
    return result;
  }
}
