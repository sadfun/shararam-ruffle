// Activity Sequence: the exact order and nesting of activities inside ONE
// selected frame (with a range selected there would be too much to show —
// Scout's own rule). Nesting is inferred from the span timings; trace-like
// lines (ExternalInterface calls) appear inline in orange.

import { ProfileModel, formatClock, formatMs } from "./model";
import { FrameData } from "./frameData";
import { ScoutState } from "./state";
import { CATEGORIES, TRACE_COLOR } from "./categories";
import { activityLabelOf } from "./activityLabel";
import { eventsInRange, SPAN_CAP_MS } from "./frameData";
import { scoutMs } from "./summaryPanel";

const SMALL_MS = 0.5;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Node {
  index: number;
  start: number;
  end: number;
  children: Node[];
}

export class ActivitySequence {
  hideSmall = true;
  activityFilter: string | null = null;
  private expandedOverride = new Map<number, boolean>();

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {}

  private buildTree(frame: number): { roots: Node[]; hiddenCount: number } {
    const endMs = this.model.frameTimesMs[frame];
    const startMs = endMs - this.model.frameDtMs[frame];
    interface Item {
      index: number;
      start: number;
      end: number;
    }
    const items: Item[] = [];
    eventsInRange(this.model, startMs, endMs, index => {
      if (this.data.eventCat[index] < 0) return;
      const dur = Math.min(Math.max(this.model.durMs[index], 0), SPAN_CAP_MS);
      items.push({ index, start: this.model.startMs[index], end: this.model.startMs[index] + dur });
    });
    // seq DESC on ties: spans are written at close, children close first
    const seq = this.model.seq;
    items.sort(
      (x, y) => x.start - y.start || y.end - x.end || seq[y.index] - seq[x.index]
    );
    const roots: Node[] = [];
    const stack: Node[] = [];
    const EPS = 0.0005;
    for (const item of items) {
      while (stack.length && stack[stack.length - 1].end <= item.start + EPS) stack.pop();
      const node: Node = { index: item.index, start: item.start, end: item.end, children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      if (item.end > item.start) stack.push(node);
    }
    return { roots, hiddenCount: 0 };
  }

  render() {
    const container = this.container;
    container.textContent = "";
    const selection = this.state.selection;
    if (!selection || selection.a !== selection.b) {
      container.appendChild(
        el(
          "div",
          "details-empty",
          "Последовательность показывается для одного кадра: кликните по кадру в таймлайне (для диапазона данных было бы слишком много)."
        )
      );
      return;
    }
    const frame = selection.a;
    const dtMs = this.model.frameDtMs[frame];
    const activeMs = Math.max(this.data.activeMs[frame], 0.001);
    const { roots } = this.buildTree(frame);

    const toolbar = el("div", "panel-toolbar");
    const toggle = el("button", `mini-button${this.hideSmall ? " active" : ""}`, "скрывать мелкое");
    toggle.title = `Активности с total < ${SMALL_MS} мс`;
    toggle.addEventListener("click", () => {
      this.hideSmall = !this.hideSmall;
      this.render();
    });
    toolbar.appendChild(toggle);
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(
      el("span", "dim", `кадр @${formatClock(this.model.frameTimesMs[frame] - dtMs)} · ${formatMs(dtMs)}`)
    );
    container.appendChild(toolbar);

    const table = el("table", "grid") as HTMLTableElement;
    const head = table.createTHead().insertRow();
    head.appendChild(el("th", "", "Активность"));
    head.appendChild(el("th", "num", "Total (мс)"));
    head.appendChild(el("th", "num", "%"));
    head.appendChild(el("th", "num", "Self (мс)"));
    const body = table.createTBody();

    let hiddenCount = 0;
    const renderNode = (node: Node, depth: number) => {
      const total = node.end - node.start;
      const isTrace = this.model.kinds[this.model.kindIds[node.index]].cat === "external";
      if (this.hideSmall && total < SMALL_MS && !node.children.length && !isTrace) {
        hiddenCount++;
        return;
      }
      const cat = this.data.eventCat[node.index];
      const label = activityLabelOf(this.model, this.data, node.index);
      const seq = this.model.seq[node.index];
      const hasChildren = node.children.length > 0;
      const expanded = this.expandedOverride.get(seq) ?? depth < 2;

      const tr = body.insertRow();
      tr.className = "clickable";
      const filteredOut = this.state.categoryFilter !== null && this.state.categoryFilter !== cat;
      if (filteredOut) tr.classList.add("row-dim");
      if (this.activityFilter && label === this.activityFilter) tr.classList.add("row-picked");
      const name = tr.insertCell();
      name.style.paddingLeft = `${8 + depth * 16}px`;
      if (hasChildren) {
        const arrow = el("span", "tree-arrow", expanded ? "▼ " : "▶ ");
        name.appendChild(arrow);
      } else {
        name.appendChild(el("span", "tree-arrow dim", "· "));
      }
      const text = el("span", "", isTrace ? `Trace: ${label.replace(/^ExternalInterface: /, "")}` : label);
      if (!filteredOut) text.style.color = isTrace ? TRACE_COLOR : cat >= 0 ? CATEGORIES[cat].color : "";
      name.appendChild(text);
      const totalCell = tr.insertCell();
      totalCell.className = "num";
      totalCell.textContent = total >= 1 ? scoutMs(total) : total > 0 ? "< 1" : "";
      totalCell.title = `${formatMs(total)} · @${formatClock(node.start)}`;
      const pct = tr.insertCell();
      pct.className = "num";
      pct.textContent = total > 0 ? `${Math.round((total / activeMs) * 100)} %` : "";
      const selfCell = tr.insertCell();
      selfCell.className = "num dim";
      const self = this.data.selfMs[node.index];
      selfCell.textContent = self >= 1 ? scoutMs(self) : self > 0 ? "< 1" : "";

      tr.addEventListener("click", () => {
        if (!hasChildren) return;
        this.expandedOverride.set(seq, !expanded);
        this.render();
      });

      if (hasChildren && expanded) {
        for (const child of node.children) renderNode(child, depth + 1);
      }
    };
    for (const root of roots) renderNode(root, 0);
    container.appendChild(table);

    if (hiddenCount > 0) {
      container.appendChild(
        el("div", "dim panel-note", `скрыто мелких (< ${SMALL_MS} мс): ${hiddenCount}`)
      );
    }
    if (!roots.length) {
      container.appendChild(el("div", "details-empty", "Внутри кадра не записано ни одной активности."));
    }
  }
}
