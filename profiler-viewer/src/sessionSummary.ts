// Session Summary: the narrow strip above the Frame Timeline showing the
// whole session at a glance — where the spikes are. Click jumps the
// timeline there; the lighter box mirrors the visible viewport range.

import { ProfileModel } from "./model";
import { FrameData } from "./frameData";
import { ScoutState } from "./state";
import { Viewport, prepareCanvas } from "./view";
import { BUDGET_COLOR } from "./categories";
import { LEFT_GUTTER } from "./frameTimeline";

const GAP_MS = 500;

export class SessionSummary {
  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {
    canvas.addEventListener("pointerdown", event => {
      const rect = canvas.getBoundingClientRect();
      const ratio = (event.clientX - rect.left - LEFT_GUTTER) / (rect.width - LEFT_GUTTER);
      const center = ratio * this.viewport.totalMs;
      const span = this.viewport.span();
      this.viewport.setRange(center - span / 2, center + span / 2);
    });
  }

  draw() {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const plotWidth = Math.max(Math.floor(width - LEFT_GUTTER), 1);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#2b2d2b";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#232523";
    ctx.fillRect(LEFT_GUTTER, 0, plotWidth, height);
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#8f918f";
    ctx.fillText("Сессия", 6, height / 2 + 3);

    const times = this.model.frameTimesMs;
    const dts = this.model.frameDtMs;
    const total = this.viewport.totalMs;
    const yMax = 120; // fixed: the strip is an overview, not a measurement

    // per-pixel worst frame, grey (memory leak hunting happens in the strip
    // too, but frame time is the default Scout shows)
    ctx.fillStyle = "#6a6d6a";
    const pixelWorst = new Float64Array(plotWidth);
    for (let i = 0; i < times.length; i++) {
      const x = Math.floor((times[i] / total) * plotWidth);
      if (x < 0 || x >= plotWidth) continue;
      const dt = Math.min(dts[i], GAP_MS);
      if (dt > pixelWorst[x]) pixelWorst[x] = dt;
    }
    for (let x = 0; x < plotWidth; x++) {
      if (!pixelWorst[x]) continue;
      const h = Math.min(pixelWorst[x] / yMax, 1) * (height - 4);
      ctx.fillRect(LEFT_GUTTER + x, height - 2 - h, 1, h);
    }

    // budget line
    const budgetY = height - 2 - Math.min(this.state.budgetMs() / yMax, 1) * (height - 4);
    ctx.strokeStyle = BUDGET_COLOR;
    ctx.beginPath();
    ctx.moveTo(LEFT_GUTTER, budgetY);
    ctx.lineTo(width, budgetY);
    ctx.stroke();

    // selection marker
    const selection = this.state.selection;
    if (selection) {
      const x0 = LEFT_GUTTER + ((times[selection.a] - dts[selection.a]) / total) * plotWidth;
      const x1 = LEFT_GUTTER + (times[selection.b] / total) * plotWidth;
      ctx.fillStyle = "rgba(33, 158, 222, 0.35)";
      ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), height);
    }

    // viewport window
    const w0 = LEFT_GUTTER + (Math.max(this.viewport.v0, 0) / total) * plotWidth;
    const w1 = LEFT_GUTTER + (Math.min(this.viewport.v1, total) / total) * plotWidth;
    ctx.strokeStyle = "#c8cac8";
    ctx.strokeRect(w0 + 0.5, 0.5, Math.max(w1 - w0 - 1, 4), height - 1);
  }
}
