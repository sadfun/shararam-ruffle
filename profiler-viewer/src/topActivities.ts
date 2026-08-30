// Top Activities: activities of the selected frame range grouped by name,
// self time descending — Scout's "where did the time actually go" table.
// Small items are hidden by default, but the omission is always labeled.

import { ProfileModel, formatMs } from "./model";
import { FrameData, eventsInRange } from "./frameData";
import { ScoutState } from "./state";
import { CATEGORIES } from "./categories";
import { activityLabelOf } from "./activityLabel";
import { scoutMs } from "./summaryPanel";

const SMALL_MS = 0.5;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TopActivities {
  hideSmall = true;
  /** activity label picked as a filter for the sequence panel, or null */
  activityFilter: string | null = null;
  onActivityFilter: (label: string | null) => void = () => {};

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {}

  render() {
    const container = this.container;
    container.textContent = "";
    const selection = this.state.selection ?? { a: 0, b: this.model.frameTimesMs.length - 1 };
    const aMs = this.model.frameTimesMs[selection.a] - this.model.frameDtMs[selection.a];
    const bMs = this.model.frameTimesMs[selection.b];

    interface Group {
      label: string;
      cat: number;
      ms: number;
      count: number;
    }
    const groups = new Map<string, Group>();
    let activeMs = 0;
    for (let f = selection.a; f <= selection.b; f++) activeMs += this.data.activeMs[f];
    eventsInRange(this.model, aMs, bMs, index => {
      const cat = this.data.eventCat[index];
      if (cat < 0) return;
      const label = activityLabelOf(this.model, this.data, index);
      let group = groups.get(label);
      if (!group) groups.set(label, (group = { label, cat, ms: 0, count: 0 }));
      group.ms += this.data.selfMs[index];
      group.count++;
    });

    const all = [...groups.values()].sort((x, y) => y.ms - x.ms);
    const shown = this.hideSmall ? all.filter(group => group.ms >= SMALL_MS) : all;
    const hidden = all.length - shown.length;

    const toolbar = el("div", "panel-toolbar");
    const toggle = el("button", `mini-button${this.hideSmall ? " active" : ""}`, "скрывать мелкое");
    toggle.title = `Активности с self time < ${SMALL_MS} мс`;
    toggle.addEventListener("click", () => {
      this.hideSmall = !this.hideSmall;
      this.render();
    });
    toolbar.appendChild(toggle);
    if (this.activityFilter) {
      const clear = el("button", "mini-button active", `фильтр: ${this.activityFilter} ✕`);
      clear.addEventListener("click", () => {
        this.activityFilter = null;
        this.onActivityFilter(null);
        this.render();
      });
      toolbar.appendChild(clear);
    }
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(el("span", "dim", `Активное время ${scoutMs(activeMs)} мс`));
    container.appendChild(toolbar);

    if (!shown.length) {
      container.appendChild(el("div", "details-empty", "В выделении нет активностей."));
      return;
    }

    const table = el("table", "grid") as HTMLTableElement;
    const head = table.createTHead().insertRow();
    head.appendChild(el("th", "", "Активность"));
    head.appendChild(el("th", "num", "Self (мс)"));
    head.appendChild(el("th", "num", "%"));
    head.appendChild(el("th", "num", "раз"));
    const body = table.createTBody();
    for (const group of shown) {
      const tr = body.insertRow();
      tr.className = "clickable";
      const filteredOut =
        this.state.categoryFilter !== null && this.state.categoryFilter !== group.cat;
      if (filteredOut) tr.classList.add("row-dim");
      if (this.activityFilter === group.label) tr.classList.add("row-picked");
      const name = tr.insertCell();
      name.textContent = group.label;
      if (!filteredOut) name.style.color = CATEGORIES[group.cat].color;
      const self = tr.insertCell();
      self.className = "num";
      self.textContent = group.ms >= 1 ? scoutMs(group.ms) : group.ms > 0 ? "< 1" : "0";
      self.title = formatMs(group.ms);
      const pct = tr.insertCell();
      pct.className = "num";
      pct.textContent = activeMs > 0 ? `${Math.round((group.ms / activeMs) * 100)} %` : "";
      const count = tr.insertCell();
      count.className = "num dim";
      count.textContent = String(group.count);
      tr.title = "Клик — фильтровать последовательность кадра этой активностью";
      tr.addEventListener("click", () => {
        this.activityFilter = this.activityFilter === group.label ? null : group.label;
        this.onActivityFilter(this.activityFilter);
        this.render();
      });
    }
    container.appendChild(table);
    if (hidden > 0) {
      container.appendChild(el("div", "dim panel-note", `скрыто мелких (< ${SMALL_MS} мс): ${hidden}`));
    }
  }
}
