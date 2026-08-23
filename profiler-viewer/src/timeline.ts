// The unified per-category timeline: spans as bars, instants as ticks,
// markers as labeled flags. Density-safe (sub-pixel events collapse into
// saturating strips) so hundreds of thousands of events stay smooth.

import { ProfileModel, formatMs, formatClock } from "./model";
import { Viewport, prepareCanvas, tickStepMs, lowerBound } from "./view";
import { LEFT_GUTTER } from "./fps";

const ROW_HEIGHT = 16;
const LANE_PADDING = 6;
const FLAGS_HEIGHT = 22;
const AXIS_HEIGHT = 18;

interface HitBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  index: number;
}

export class Timeline {
  private hits: HitBox[] = [];
  private laneTops: number[] = [];
  hoveredIndex = -1;
  selectedIndex = -1;

  constructor(
    private canvas: HTMLCanvasElement,
    private viewport: Viewport,
    private model: ProfileModel
  ) {}

  preferredHeight(): number {
    let height = FLAGS_HEIGHT + AXIS_HEIGHT + 8;
    for (const lane of this.model.lanes) {
      height += lane.depth * ROW_HEIGHT + LANE_PADDING;
    }
    return height;
  }

  hitTest(x: number, y: number): number {
    // Iterate from the end: later-drawn (topmost) boxes win.
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const hit = this.hits[i];
      if (x >= hit.x0 - 2 && x <= hit.x1 + 2 && y >= hit.y0 && y <= hit.y1) return hit.index;
    }
    return -1;
  }

  describe(index: number): string {
    const model = this.model;
    const kind = model.kinds[model.kindIds[index]];
    const dur = model.durMs[index];
    return `${kind.cat}/${kind.name}${dur > 0 ? ` · ${formatMs(dur)}` : ""} · @${formatClock(model.startMs[index])}`;
  }

  draw() {
    const { ctx, width, height } = prepareCanvas(this.canvas);
    const plotWidth = width - LEFT_GUTTER;
    const model = this.model;
    const viewport = this.viewport;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#141517";
    ctx.fillRect(0, 0, width, height);
    this.hits = [];
    this.laneTops = [];

    // lane backgrounds + labels
    let y = FLAGS_HEIGHT;
    ctx.font = "11px ui-monospace, Menlo, monospace";
    for (let laneId = 0; laneId < model.lanes.length; laneId++) {
      const lane = model.lanes[laneId];
      const laneHeight = lane.depth * ROW_HEIGHT;
      this.laneTops.push(y);
      ctx.fillStyle = laneId % 2 ? "#17181b" : "#151619";
      ctx.fillRect(LEFT_GUTTER, y, plotWidth, laneHeight);
      ctx.fillStyle = lane.color;
      ctx.fillRect(LEFT_GUTTER - 5, y + 2, 2, laneHeight - 4);
      ctx.fillStyle = "#b8bac0";
      ctx.fillText(lane.label, 8, y + 11);
      y += laneHeight + LANE_PADDING;
    }
    const axisY = y;

    // visible index range
    const from = Math.max(lowerBound(model.startMs, viewport.v0 - 60000) , 0);
    const to = Math.min(lowerBound(model.startMs, viewport.v1) + 1, model.count);

    // density strips for sub-pixel content, per lane row
    const laneRows = this.laneTops.length;
    void laneRows;

    const minPx = 1.2;
    ctx.textBaseline = "alphabetic";
    for (let i = from; i < to; i++) {
      const kind = model.kinds[model.kindIds[i]];
      const laneTop = this.laneTops[kind.lane];
      const rowY = laneTop + model.subRow[i] * ROW_HEIGHT;
      const startX = viewport.xOf(model.startMs[i], plotWidth);
      const endX = viewport.xOf(model.startMs[i] + model.durMs[i], plotWidth);
      if (endX < -4 || startX > plotWidth + 4) continue;
      const x0 = LEFT_GUTTER + Math.max(startX, -3);
      const x1 = LEFT_GUTTER + Math.min(endX, plotWidth + 3);
      const isInstant = model.durMs[i] <= 0;
      const selected = i === this.selectedIndex;
      const hovered = i === this.hoveredIndex;

      if (isInstant) {
        ctx.fillStyle = selected || hovered ? "#ffffff" : kind.color;
        ctx.fillRect(x0 - 0.5, rowY + 3, selected ? 2.5 : 1.5, ROW_HEIGHT - 6);
        this.hits.push({ x0, x1: x0 + 2, y0: rowY, y1: rowY + ROW_HEIGHT, index: i });
      } else {
        const barWidth = Math.max(x1 - x0, minPx);
        ctx.fillStyle = kind.color;
        ctx.globalAlpha = barWidth < 2 ? 0.75 : 0.95;
        ctx.fillRect(x0, rowY + 2, barWidth, ROW_HEIGHT - 4);
        ctx.globalAlpha = 1;
        if (selected || hovered) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = selected ? 1.5 : 1;
          ctx.strokeRect(x0 + 0.5, rowY + 2.5, barWidth - 1, ROW_HEIGHT - 5);
        }
        if (barWidth > 42) {
          ctx.fillStyle = "#0d0e10";
          ctx.font = "10px ui-monospace, Menlo, monospace";
          const label = `${kind.name} ${formatMs(model.durMs[i])}`;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 2, rowY, barWidth - 4, ROW_HEIGHT);
          ctx.clip();
          ctx.fillText(label, x0 + 4, rowY + 12);
          ctx.restore();
          ctx.font = "11px ui-monospace, Menlo, monospace";
        }
        this.hits.push({ x0, x1: x0 + barWidth, y0: rowY, y1: rowY + ROW_HEIGHT, index: i });
      }
    }

    // markers ("flags" across the top): game milestones + errors
    ctx.font = "10px ui-monospace, Menlo, monospace";
    let lastFlagRight = -1e9;
    for (let i = from; i < to; i++) {
      const kind = model.kinds[model.kindIds[i]];
      const isFlag =
        kind.cat === "marker" ||
        (kind.cat === "load" && (kind.name === "root_movie" || kind.name === "movie_error")) ||
        (kind.cat === "rtmp" && (kind.name === "connect" || kind.name === "transport"));
      if (!isFlag) continue;
      const x = LEFT_GUTTER + viewport.xOf(model.startMs[i], plotWidth);
      if (x < LEFT_GUTTER - 4 || x > width) continue;
      const isError = kind.name === "movie_error";
      ctx.strokeStyle = isError ? "#e66767" : "#8a8a80";
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, FLAGS_HEIGHT - 4);
      ctx.lineTo(Math.round(x) + 0.5, axisY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (x > lastFlagRight + 8) {
        ctx.fillStyle = isError ? "#e66767" : "#b8bac0";
        const label = kind.name;
        ctx.fillText(label, x + 2, 12);
        lastFlagRight = x + ctx.measureText(label).width;
      }
      this.hits.push({ x0: x - 2, x1: x + 2, y0: 0, y1: FLAGS_HEIGHT, index: i });
    }

    // time axis
    ctx.fillStyle = "#7d7f83";
    ctx.strokeStyle = "#26282c";
    const step = tickStepMs(viewport.span(), Math.max(plotWidth / 90, 2));
    const first = Math.ceil(viewport.v0 / step) * step;
    for (let t = first; t <= viewport.v1; t += step) {
      const x = Math.round(LEFT_GUTTER + viewport.xOf(t, plotWidth)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY + 4);
      ctx.stroke();
      ctx.fillText(formatClock(t), x + 3, axisY + 14);
    }
  }
}
