// FPS chart: per-pixel average FPS line, slow frames highlighted, gaps
// (hidden page / no animation frames) shaded.

import { ProfileModel, formatClock } from "./model";
import { Viewport, prepareCanvas, tickStepMs, lowerBound } from "./view";

export const LEFT_GUTTER = 64;
const GAP_THRESHOLD_MS = 500;
const SLOW_FRAME_MS = 50;

export class FpsChart {
  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private model: ProfileModel
  ) {}

  summary(): string {
    const dt = this.model.frameDtMs;
    if (!dt.length) return "нет кадров";
    let sum = 0;
    let slow = 0;
    let counted = 0;
    for (let i = 0; i < dt.length; i++) {
      if (dt[i] > GAP_THRESHOLD_MS) continue; // gap, not a frame interval
      sum += dt[i];
      counted++;
      if (dt[i] > SLOW_FRAME_MS) slow++;
    }
    if (!counted) return "нет кадров";
    const avg = 1000 / (sum / counted);
    return `в среднем ${avg.toFixed(1)} fps · медленных кадров (>${SLOW_FRAME_MS}мс): ${slow}`;
  }

  draw() {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const plotWidth = width - LEFT_GUTTER;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#141517";
    ctx.fillRect(0, 0, width, height);

    const axisTop = 6;
    const axisBottom = height - 16;
    const plotHeight = axisBottom - axisTop;
    const maxFps = 65;
    const yOf = (fps: number) => axisBottom - (Math.min(fps, maxFps) / maxFps) * plotHeight;

    // grid: 0/30/60 fps
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#7d7f83";
    ctx.strokeStyle = "#26282c";
    ctx.lineWidth = 1;
    for (const fps of [0, 30, 60]) {
      const y = Math.round(yOf(fps)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(LEFT_GUTTER, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(`${fps}`, LEFT_GUTTER - 22, y + 3);
    }

    const times = this.model.frameTimesMs;
    const dts = this.model.frameDtMs;
    if (times.length) {
      const from = Math.max(lowerBound(times, this.viewport.v0) - 1, 0);
      const to = Math.min(lowerBound(times, this.viewport.v1) + 1, times.length);

      // gaps (no rAF for a while: hidden page or a giant stall)
      ctx.fillStyle = "rgba(122, 125, 131, 0.16)";
      for (let i = Math.max(from, 1); i < to; i++) {
        if (dts[i] > GAP_THRESHOLD_MS) {
          const x0 = LEFT_GUTTER + this.viewport.xOf(times[i] - dts[i], plotWidth);
          const x1 = LEFT_GUTTER + this.viewport.xOf(times[i], plotWidth);
          ctx.fillRect(x0, axisTop, Math.max(x1 - x0, 1), plotHeight);
        }
      }

      // slow frames as columns from the bottom (frame time, capped)
      ctx.fillStyle = "rgba(230, 103, 103, 0.85)";
      for (let i = from; i < to; i++) {
        if (dts[i] > SLOW_FRAME_MS && dts[i] <= GAP_THRESHOLD_MS) {
          const x = LEFT_GUTTER + this.viewport.xOf(times[i], plotWidth);
          const h = Math.min(dts[i] / 200, 1) * plotHeight * 0.5;
          ctx.fillRect(x - 1, axisBottom - h, 2, h);
        }
      }

      // per-pixel min/avg fps line
      ctx.strokeStyle = "#3987e5";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      let pixel = -1;
      let bucketSum = 0;
      let bucketCount = 0;
      const flush = (px: number) => {
        if (!bucketCount) return;
        const fps = 1000 / (bucketSum / bucketCount);
        const x = LEFT_GUTTER + px + 0.5;
        const y = yOf(fps);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        bucketSum = 0;
        bucketCount = 0;
      };
      for (let i = from; i < to; i++) {
        if (dts[i] > GAP_THRESHOLD_MS) {
          flush(pixel);
          started = false; // break the line across gaps
          continue;
        }
        const px = Math.floor(this.viewport.xOf(times[i], plotWidth));
        if (px !== pixel) {
          flush(pixel);
          pixel = px;
        }
        bucketSum += dts[i];
        bucketCount++;
      }
      flush(pixel);
      ctx.stroke();
    }

    // wasm memory as a soft line along the bottom half, scaled to its max
    const memory = this.model.samples.find(sample => sample.name === "wasm_memory_bytes");
    if (memory && memory.values.length > 1) {
      let max = 0;
      for (const value of memory.values) max = Math.max(max, value);
      if (max > 0) {
        ctx.strokeStyle = "rgba(144, 133, 233, 0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < memory.timesMs.length; i++) {
          const x = LEFT_GUTTER + this.viewport.xOf(memory.timesMs[i], plotWidth);
          const y = axisBottom - (memory.values[i] / max) * plotHeight * 0.35;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = "rgba(144, 133, 233, 0.8)";
        ctx.fillText(`wasm mem ≤ ${(max / 1048576).toFixed(0)}MB`, width - 130, axisTop + 10);
      }
    }

    // time axis
    const step = tickStepMs(this.viewport.span(), Math.max(plotWidth / 90, 2));
    ctx.fillStyle = "#7d7f83";
    ctx.strokeStyle = "#26282c";
    const first = Math.ceil(this.viewport.v0 / step) * step;
    for (let t = first; t <= this.viewport.v1; t += step) {
      const x = Math.round(LEFT_GUTTER + this.viewport.xOf(t, plotWidth)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, axisBottom);
      ctx.lineTo(x, axisBottom + 4);
      ctx.stroke();
      ctx.fillText(formatClock(t), x + 3, height - 4);
    }

    ctx.fillStyle = "#7d7f83";
    ctx.fillText("fps", 8, axisTop + 10);
  }
}
