// Экран — the analog of Scout's DisplayList Rendering screen map, adapted
// honestly to Ruffle: the wgpu backend re-renders the whole stage every
// frame, so there are no Flash-style redraw regions. What the fork records
// instead is WHERE the draw commands land: a 24×18 grid of how many commands
// cover each screen cell (overdraw), a separate layer for commands inside
// blend/alpha-mask subtrees (each costs a full offscreen pass), and the
// screen rects of those subtrees. The grid is drawn over the nearest
// screen-recording frame, so "what is this expensive area" is one glance.

import { query } from "./db";
import { ProfileModel, formatClock } from "./model";
import { FrameData } from "./frameData";
import { ScoutState } from "./state";
import { lowerBound } from "./view";

type Mode = "draws" | "heavy";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const HOT_LABELS: Record<string, string> = {
  blend_layer: "бленд Layer",
  blend_alpha_erase: "бленд Alpha/Erase",
  blend: "сложный бленд",
  blend_shader: "шейдерный бленд",
  alpha_mask: "альфа-маска"
};

export class ScreenPanel {
  mode: Mode = "draws";
  private snapshotUrl: string | null = null;
  private snapshotTsUs = 0;
  private image: HTMLImageElement | null = null;

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState,
    private showTooltip: (clientX: number, clientY: number, text: string) => void,
    private hideTooltip: () => void
  ) {}

  render() {
    const container = this.container;
    container.textContent = "";
    const grid = this.data.screenGrid;
    if (!grid) {
      container.appendChild(
        el(
          "div",
          "details-empty",
          "Карта команд экрана не записана в этом профиле. Нужна профилировочная " +
            "сборка с бандлом web-profiler от 30.08+ — она пишет сетку 24×18 " +
            "покрытия экрана рендер-командами для каждого кадра."
        )
      );
      return;
    }

    const frameCount = this.model.frameTimesMs.length;
    const selection = this.state.selection ?? { a: 0, b: frameCount - 1 };
    const frames = selection.b - selection.a + 1;
    const cellCount = grid.gw * grid.gh;

    // aggregate the selected frames (cells are relative screen areas, so
    // frames with different viewport sizes still add up meaningfully)
    const cells = new Float64Array(cellCount);
    const source = this.mode === "heavy" ? grid.heavy : grid.draws;
    let framesWithData = 0;
    let viewportW = 0;
    let viewportH = 0;
    for (let f = selection.a; f <= selection.b; f++) {
      const base = f * cellCount;
      let any = false;
      for (let c = 0; c < cellCount; c++) {
        cells[c] += source[base + c];
        if (grid.draws[base + c]) any = true;
      }
      if (any) framesWithData++;
      if (grid.viewportW[f]) {
        viewportW = grid.viewportW[f];
        viewportH = grid.viewportH[f];
      }
    }
    const perFrame = Math.max(framesWithData, 1);
    let maxCell = 0;
    let totalDraws = 0;
    for (let c = 0; c < cellCount; c++) {
      cells[c] /= perFrame;
      if (cells[c] > maxCell) maxCell = cells[c];
      totalDraws += cells[c];
    }

    const toolbar = el("div", "panel-toolbar");
    const modes: [Mode, string][] = [
      ["draws", "Перерисовки"],
      ["heavy", "Тяжёлые (бленды/маски)"]
    ];
    for (const [mode, label] of modes) {
      const button = el("button", `mini-button${this.mode === mode ? " active" : ""}`, label);
      button.addEventListener("click", () => {
        this.mode = mode;
        this.render();
      });
      toolbar.appendChild(button);
    }
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(
      el(
        "span",
        "dim",
        frames === 1
          ? `кадр ${selection.a}`
          : `среднее по ${framesWithData.toLocaleString("ru")} кадрам с рендером`
      )
    );
    container.appendChild(toolbar);

    if (!framesWithData) {
      container.appendChild(el("div", "details-empty", "В выделении не было рендера кадров."));
      return;
    }

    // hot rects: draw for a single frame, summarize for a range
    const hotRects = frames === 1 ? (grid.hotByFrame.get(selection.a) ?? []) : [];
    const hotSummary = new Map<string, number>();
    if (frames > 1) {
      for (let f = selection.a; f <= selection.b; f++) {
        for (const rect of grid.hotByFrame.get(f) ?? []) {
          hotSummary.set(rect[4], (hotSummary.get(rect[4]) ?? 0) + 1);
        }
      }
    }

    const wrap = el("div", "screen-wrap");
    const canvas = document.createElement("canvas");
    canvas.id = "screen-canvas";
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const aspect = viewportW && viewportH ? viewportH / viewportW : grid.gh / grid.gw;
    const drawAll = () => this.paint(canvas, cells, maxCell, aspect, hotRects, viewportW, viewportH);

    // backdrop: recording frame nearest to the selection end
    void this.loadSnapshot(this.model.frameTimesMs[selection.b]).then(drawAll);
    drawAll();

    canvas.addEventListener("pointermove", event => {
      const rect = canvas.getBoundingClientRect();
      const gx = Math.min(Math.floor(((event.clientX - rect.left) / rect.width) * grid.gw), grid.gw - 1);
      const gy = Math.min(Math.floor(((event.clientY - rect.top) / rect.height) * grid.gh), grid.gh - 1);
      const value = cells[gy * grid.gw + gx];
      this.showTooltip(
        event.clientX,
        event.clientY,
        `ячейка ${gx},${gy}: ${value.toFixed(value >= 10 ? 0 : 1)} ` +
          (this.mode === "draws" ? "команд/кадр" : "тяжёлых команд/кадр")
      );
    });
    canvas.addEventListener("pointerleave", () => this.hideTooltip());

    const facts = el("div", "panel-note");
    const label = this.mode === "draws" ? "рисующих команд" : "тяжёлых команд";
    facts.appendChild(
      el(
        "span",
        "",
        `Всего ${label} на кадр: ${Math.round(totalDraws)} (пик ячейки ${Math.round(maxCell)}). `
      )
    );
    if (hotRects.length) {
      facts.appendChild(
        el("span", "dim", `Контуры — бленды/маски кадра: ${hotRects.map(r => HOT_LABELS[r[4]] ?? r[4]).join(", ")}.`)
      );
    } else if (hotSummary.size) {
      const parts = [...hotSummary.entries()].map(
        ([kind, count]) => `${HOT_LABELS[kind] ?? kind} ×${count.toLocaleString("ru")}`
      );
      facts.appendChild(el("span", "dim", `Бленды/маски в диапазоне: ${parts.join(", ")}.`));
    }
    container.appendChild(facts);
    container.appendChild(
      el(
        "div",
        "dim panel-note",
        "Сетка считает, сколько рисующих команд покрывает каждую область экрана " +
          "(overdraw), — это состав работы, а не миллисекунды GPU. «Тяжёлые» — " +
          "команды внутри блендов и альфа-масок: каждый такой узел в wgpu стоит " +
          "оффскрин-проход размером с экран. Подложка — ближайший кадр записи."
      )
    );
  }

  private paint(
    canvas: HTMLCanvasElement,
    cells: Float64Array,
    maxCell: number,
    aspect: number,
    hotRects: [number, number, number, number, string][],
    viewportW: number,
    viewportH: number
  ) {
    const grid = this.data.screenGrid!;
    const cssWidth = Math.min(canvas.parentElement?.clientWidth || 520, 520);
    const cssHeight = Math.round(cssWidth * aspect);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#1a1c1a";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    if (this.image) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.image, 0, 0, cssWidth, cssHeight);
      ctx.globalAlpha = 1;
    }

    const cellW = cssWidth / grid.gw;
    const cellH = cssHeight / grid.gh;
    for (let gy = 0; gy < grid.gh; gy++) {
      for (let gx = 0; gx < grid.gw; gx++) {
        const value = cells[gy * grid.gw + gx];
        if (value <= 0 || maxCell <= 0) continue;
        const alpha = Math.min(value / maxCell, 1) * 0.6;
        ctx.fillStyle = this.mode === "draws" ? `rgba(222, 12, 8, ${alpha})` : `rgba(232, 163, 61, ${alpha})`;
        ctx.fillRect(gx * cellW, gy * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // faint grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    for (let gx = 1; gx < grid.gw; gx++) {
      ctx.moveTo(gx * cellW, 0);
      ctx.lineTo(gx * cellW, cssHeight);
    }
    for (let gy = 1; gy < grid.gh; gy++) {
      ctx.moveTo(0, gy * cellH);
      ctx.lineTo(cssWidth, gy * cellH);
    }
    ctx.stroke();

    if (hotRects.length && viewportW && viewportH) {
      const sx = cssWidth / viewportW;
      const sy = cssHeight / viewportH;
      ctx.strokeStyle = "#219ede";
      ctx.lineWidth = 1.5;
      for (const [x, y, w, h] of hotRects) {
        ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
      }
      ctx.lineWidth = 1;
    }
  }

  private async loadSnapshot(ms: number): Promise<void> {
    if (!this.model.snapTimesMs.length) return;
    const times = this.model.snapTimesMs;
    let index = lowerBound(times, ms);
    if (index >= times.length) index = times.length - 1;
    if (index > 0 && Math.abs(times[index - 1] - ms) < Math.abs(times[index] - ms)) index--;
    const tsUs = this.model.snapTsUs[index];
    if (tsUs === this.snapshotTsUs && this.image) return;
    try {
      const { rows } = await query(
        `SELECT bytes, mime FROM snapshots WHERE ts_us = ${Math.round(tsUs)} LIMIT 1`
      );
      if (!rows.length) return;
      const raw = rows[0]["bytes"];
      const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as number[]);
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy.buffer], { type: String(rows[0]["mime"] ?? "image/jpeg") }));
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("snapshot decode"));
        image.src = url;
      });
      if (this.snapshotUrl) URL.revokeObjectURL(this.snapshotUrl);
      this.snapshotUrl = url;
      this.snapshotTsUs = tsUs;
      this.image = image;
    } catch (error) {
      console.warn("screen panel snapshot", error, formatClock(ms));
    }
  }
}
