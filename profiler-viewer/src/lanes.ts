// Metric lanes: every per-frame series as a thin aligned strip under the
// FPS chart, sharing the zoomable viewport. The point is visual
// correlation by the reader — an FPS dip and whatever jumps under it are
// on the same vertical line. Hovering reads out the exact value of every
// metric at the cursor; nothing is filtered or ranked.

import { MetricSeries, formatMetric } from "./metrics";
import { ProfileModel, formatClock } from "./model";
import { Viewport, prepareCanvas, lowerBound } from "./view";
import { LEFT_GUTTER } from "./fps";

const LANE_HEIGHT = 17;
const GAP_THRESHOLD_MS = 500;

export class MetricLanes {
  /** shared scrub cursor (profile ms) */
  cursorMs: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private model: ProfileModel,
    private series: MetricSeries[]
  ) {}

  preferredHeight(): number {
    return this.series.length * LANE_HEIGHT + 4;
  }

  /** Frame whose window contains `ms`, or -1. */
  frameIndexAt(ms: number): number {
    const times = this.model.frameTimesMs;
    const index = lowerBound(times, ms);
    if (index >= times.length) return -1;
    if (times[index] - this.model.frameDtMs[index] > ms) return index > 0 ? index - 1 : -1;
    return index;
  }

  draw() {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const plotWidth = Math.max(Math.floor(width - LEFT_GUTTER), 1);
    const viewport = this.viewport;
    const times = this.model.frameTimesMs;
    const dts = this.model.frameDtMs;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#141517";
    ctx.fillRect(0, 0, width, height);

    const from = Math.max(lowerBound(times, viewport.v0) - 1, 0);
    const to = Math.min(lowerBound(times, viewport.v1 + GAP_THRESHOLD_MS) + 1, times.length);
    const cursorFrame = this.cursorMs !== null ? this.frameIndexAt(this.cursorMs) : -1;

    ctx.font = "10px ui-monospace, Menlo, monospace";
    const pixelMax = new Float64Array(plotWidth);

    this.series.forEach((metric, laneIndex) => {
      const yTop = 2 + laneIndex * LANE_HEIGHT;
      const yBottom = yTop + LANE_HEIGHT - 3;
      const laneHeight = yBottom - yTop;

      // per-pixel worst value, like the frame strip — spikes stay visible
      pixelMax.fill(NaN);
      for (let i = from; i < to; i++) {
        const value = metric.values[i];
        if (Number.isNaN(value)) continue;
        const x0 = viewport.xOf(times[i] - Math.min(dts[i], GAP_THRESHOLD_MS), plotWidth);
        const x1 = viewport.xOf(times[i], plotWidth);
        if (x1 < 0 || x0 > plotWidth) continue;
        const p0 = Math.max(Math.floor(x0), 0);
        const p1 = Math.min(Math.max(Math.ceil(x1), p0 + 1), plotWidth);
        for (let px = p0; px < p1; px++) {
          if (Number.isNaN(pixelMax[px]) || value > pixelMax[px]) pixelMax[px] = value;
        }
      }
      ctx.fillStyle = metric.color;
      ctx.globalAlpha = 0.8;
      for (let px = 0; px < plotWidth; px++) {
        const value = pixelMax[px];
        if (Number.isNaN(value)) continue;
        const h = Math.max(Math.min(value / metric.scaleMax, 1) * laneHeight, value > 0 ? 1 : 0);
        if (h > 0) ctx.fillRect(LEFT_GUTTER + px, yBottom - h, 1, h);
      }
      ctx.globalAlpha = 1;

      // row separator
      ctx.strokeStyle = "#1d1f22";
      ctx.beginPath();
      ctx.moveTo(0, yBottom + 1.5);
      ctx.lineTo(width, yBottom + 1.5);
      ctx.stroke();

      // label inside the lane; at the cursor it becomes a value readout
      const textY = yBottom - 3;
      ctx.fillStyle = "#b8bac0";
      ctx.fillText(metric.label, 4, textY);
      const labelEnd = 4 + ctx.measureText(metric.label).width + 8;
      if (cursorFrame >= 0) {
        ctx.fillStyle = "#e8e9eb";
        ctx.fillText(formatMetric(metric.unit, metric.values[cursorFrame]), labelEnd, textY);
      } else {
        ctx.fillStyle = "#5d5f63";
        ctx.fillText(`≤${formatMetric(metric.unit, metric.scaleMax)}`, labelEnd, textY);
      }
    });

    // scrub cursor across all lanes
    if (this.cursorMs !== null) {
      const x = Math.round(LEFT_GUTTER + viewport.xOf(this.cursorMs, plotWidth)) + 0.5;
      if (x >= LEFT_GUTTER && x <= width) {
        ctx.strokeStyle = "rgba(232, 233, 235, 0.35)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      if (cursorFrame >= 0) {
        ctx.fillStyle = "#7d7f83";
        ctx.fillText(
          `кадр @${formatClock(this.model.frameTimesMs[cursorFrame] - this.model.frameDtMs[cursorFrame])}`,
          width - 130,
          10
        );
      }
    }
  }
}
