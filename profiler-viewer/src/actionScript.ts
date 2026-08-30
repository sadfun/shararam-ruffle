// ActionScript panel — Scout's function-level sampler view. The fork's
// interpreter takes a weighted stack sample about once per millisecond of
// AVM1 execution; here the samples of the selected frame range are merged
// into a top-down tree, a bottom-up (inverted) tree or a flat function list.
// Sample weights are wall-time windows, so Σ self ≈ AVM1 execution time and
// the numbers agree with the blue ActionScript category of the timeline.

import { ProfileModel } from "./model";
import { FrameData, eventsInRange } from "./frameData";
import { ScoutState } from "./state";
import { CATEGORIES } from "./categories";
import { scoutMs } from "./summaryPanel";

const SMALL_MS = 0.5;
const AS_COLOR = CATEGORIES[0].color;

type Mode = "top" | "bottom" | "flat";

interface TreeNode {
  name: string;
  total: number;
  self: number;
  alloc: number;
  children: Map<string, TreeNode>;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function msCell(value: number): string {
  return value >= 1 ? scoutMs(value) : value > 0 ? "< 1" : "";
}

export class ActionScriptPanel {
  mode: Mode = "top";
  hideSmall = true;
  private expanded = new Map<string, boolean>();

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {}

  private collectSamples(aMs: number, bMs: number) {
    const samples: { frames: string[]; w: number; alloc: number }[] = [];
    const kinds = this.model.kinds;
    const kindIds = this.model.kindIds;
    eventsInRange(this.model, aMs, bMs, index => {
      const kind = kinds[kindIds[index]];
      if (kind.source !== "ruffle" || kind.cat !== "sampler") return;
      const info = this.data.samplerBySeq.get(this.model.seq[index]);
      if (!info) return;
      const start = this.model.startMs[index];
      const end = start + this.model.durMs[index];
      const w = Math.min(end, bMs) - Math.max(start, aMs);
      if (w <= 0) return;
      samples.push({ frames: info.stack.split(" / "), w, alloc: info.alloc });
    });
    return samples;
  }

  render() {
    const container = this.container;
    container.textContent = "";

    if (!this.data.samplerBySeq.size) {
      container.appendChild(
        el(
          "div",
          "details-empty",
          "Сэмплер стека AVM1 не записан в этом профиле. Нужна профилировочная " +
            "сборка с бандлом web-profiler от 30.08+ — она сэмплирует стек " +
            "интерпретатора раз в ~1 мс."
        )
      );
      return;
    }

    const selection = this.state.selection ?? { a: 0, b: this.model.frameTimesMs.length - 1 };
    const aMs = this.model.frameTimesMs[selection.a] - this.model.frameDtMs[selection.a];
    const bMs = this.model.frameTimesMs[selection.b];
    const samples = this.collectSamples(aMs, bMs);
    const totalW = samples.reduce((sum, sample) => sum + sample.w, 0);

    // panel-wide dim when the category filter is set to a non-AS category
    const dimAll = this.state.categoryFilter !== null && this.state.categoryFilter !== 0;

    const toolbar = el("div", "panel-toolbar");
    const modes: [Mode, string][] = [
      ["top", "Сверху вниз"],
      ["bottom", "Снизу вверх"],
      ["flat", "Функции"]
    ];
    for (const [mode, label] of modes) {
      const button = el("button", `mini-button${this.mode === mode ? " active" : ""}`, label);
      button.addEventListener("click", () => {
        this.mode = mode;
        this.expanded.clear();
        this.render();
      });
      toolbar.appendChild(button);
    }
    const toggle = el("button", `mini-button${this.hideSmall ? " active" : ""}`, "скрывать мелкое");
    toggle.title = `Ветки с total < ${SMALL_MS} мс`;
    toggle.addEventListener("click", () => {
      this.hideSmall = !this.hideSmall;
      this.render();
    });
    toolbar.appendChild(toggle);
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(
      el("span", "dim", `${samples.length.toLocaleString("ru")} сэмплов · Σ ${scoutMs(totalW)} мс`)
    );
    container.appendChild(toolbar);

    if (!samples.length) {
      container.appendChild(
        el("div", "details-empty", "В выделении нет сэмплов AVM1 — скрипты не выполнялись.")
      );
      return;
    }

    if (this.mode === "flat") this.renderFlat(container, samples, totalW, dimAll);
    else this.renderTree(container, samples, totalW, dimAll, this.mode === "bottom");

    container.appendChild(
      el(
        "div",
        "dim panel-note",
        "Сэмплирование ~1 мс: время нативных вызовов приписано вызвавшей функции, " +
          "функции короче интервала могут не попасть в выборку. «Аллок.» — число " +
          "созданных объектов AVM1, пока исполнялся этот стек."
      )
    );
  }

  private renderTree(
    container: HTMLElement,
    samples: { frames: string[]; w: number; alloc: number }[],
    totalW: number,
    dimAll: boolean,
    inverted: boolean
  ) {
    const root: TreeNode = { name: "", total: 0, self: 0, alloc: 0, children: new Map() };
    for (const sample of samples) {
      const frames = inverted ? [...sample.frames].reverse() : sample.frames;
      let node = root;
      for (const frame of frames) {
        let child = node.children.get(frame);
        if (!child) {
          node.children.set(frame, (child = { name: frame, total: 0, self: 0, alloc: 0, children: new Map() }));
        }
        child.total += sample.w;
        node = child;
      }
      node.self += sample.w;
      node.alloc += sample.alloc;
    }

    const table = el("table", "grid") as HTMLTableElement;
    const head = table.createTHead().insertRow();
    head.appendChild(el("th", "", inverted ? "Функция (и кто её вызвал ниже)" : "Функция"));
    head.appendChild(el("th", "num", "Total (мс)"));
    head.appendChild(el("th", "num", "%"));
    head.appendChild(el("th", "num", "Self (мс)"));
    head.appendChild(el("th", "num", "Аллок."));
    const body = table.createTBody();

    let hidden = 0;
    const renderNode = (node: TreeNode, depth: number, path: string) => {
      if (this.hideSmall && node.total < SMALL_MS && !node.children.size) {
        hidden++;
        return;
      }
      const hasChildren = node.children.size > 0;
      const expanded = this.expanded.get(path) ?? depth < 2;

      const tr = body.insertRow();
      tr.className = "clickable";
      if (dimAll) tr.classList.add("row-dim");
      const name = tr.insertCell();
      name.style.paddingLeft = `${8 + depth * 16}px`;
      name.appendChild(
        el("span", "tree-arrow" + (hasChildren ? "" : " dim"), hasChildren ? (expanded ? "▼ " : "▶ ") : "· ")
      );
      const text = el("span", "", node.name);
      if (!dimAll) text.style.color = AS_COLOR;
      name.appendChild(text);
      const total = tr.insertCell();
      total.className = "num";
      total.textContent = msCell(node.total);
      const pct = tr.insertCell();
      pct.className = "num";
      pct.textContent = totalW > 0 && node.total > 0 ? `${Math.round((node.total / totalW) * 100)} %` : "";
      const self = tr.insertCell();
      self.className = "num dim";
      self.textContent = msCell(node.self);
      const alloc = tr.insertCell();
      alloc.className = "num dim";
      alloc.textContent = node.alloc > 0 ? node.alloc.toLocaleString("ru") : "";

      tr.addEventListener("click", () => {
        if (!hasChildren) return;
        this.expanded.set(path, !expanded);
        this.render();
      });

      if (hasChildren && expanded) {
        const children = [...node.children.values()].sort((x, y) => y.total - x.total);
        for (const child of children) renderNode(child, depth + 1, `${path}/${child.name}`);
      }
    };
    const roots = [...root.children.values()].sort((x, y) => y.total - x.total);
    for (const node of roots) renderNode(node, 0, node.name);
    container.appendChild(table);

    if (hidden > 0) {
      container.appendChild(el("div", "dim panel-note", `скрыто мелких веток (< ${SMALL_MS} мс): ${hidden}`));
    }
  }

  private renderFlat(
    container: HTMLElement,
    samples: { frames: string[]; w: number; alloc: number }[],
    totalW: number,
    dimAll: boolean
  ) {
    interface Row {
      name: string;
      self: number;
      total: number;
      alloc: number;
      leafCount: number;
    }
    const rows = new Map<string, Row>();
    for (const sample of samples) {
      const leaf = sample.frames[sample.frames.length - 1];
      // total counts each function once per sample even if it recursed
      for (const name of new Set(sample.frames)) {
        let row = rows.get(name);
        if (!row) rows.set(name, (row = { name, self: 0, total: 0, alloc: 0, leafCount: 0 }));
        row.total += sample.w;
      }
      const row = rows.get(leaf)!;
      row.self += sample.w;
      row.alloc += sample.alloc;
      row.leafCount++;
    }

    const all = [...rows.values()].sort((x, y) => y.self - x.self || y.total - x.total);
    const shown = this.hideSmall ? all.filter(row => row.total >= SMALL_MS) : all;
    const hidden = all.length - shown.length;

    const table = el("table", "grid") as HTMLTableElement;
    const head = table.createTHead().insertRow();
    head.appendChild(el("th", "", "Функция"));
    head.appendChild(el("th", "num", "Self (мс)"));
    head.appendChild(el("th", "num", "% self"));
    head.appendChild(el("th", "num", "Total (мс)"));
    head.appendChild(el("th", "num", "сэмплов"));
    head.appendChild(el("th", "num", "Аллок."));
    const body = table.createTBody();
    for (const row of shown) {
      const tr = body.insertRow();
      if (dimAll) tr.classList.add("row-dim");
      const name = tr.insertCell();
      name.textContent = row.name;
      if (!dimAll) name.style.color = AS_COLOR;
      const self = tr.insertCell();
      self.className = "num";
      self.textContent = msCell(row.self);
      const pct = tr.insertCell();
      pct.className = "num";
      pct.textContent = totalW > 0 && row.self > 0 ? `${Math.round((row.self / totalW) * 100)} %` : "";
      const total = tr.insertCell();
      total.className = "num dim";
      total.textContent = msCell(row.total);
      const count = tr.insertCell();
      count.className = "num dim";
      count.textContent = row.leafCount ? String(row.leafCount) : "";
      const alloc = tr.insertCell();
      alloc.className = "num dim";
      alloc.textContent = row.alloc > 0 ? row.alloc.toLocaleString("ru") : "";
    }
    container.appendChild(table);
    if (hidden > 0) {
      container.appendChild(el("div", "dim panel-note", `скрыто мелких (< ${SMALL_MS} мс): ${hidden}`));
    }
  }
}
