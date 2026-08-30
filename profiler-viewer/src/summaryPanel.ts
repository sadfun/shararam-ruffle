// The Summary panel: framerate of the selection vs target, active time as a
// percent of the frame budget, self-time per category with bars, the
// Inactive breakdown (including the GPU wait Scout could never measure) and
// the memory section. Clicking a category greys everything else across the
// whole app — Scout's legend-as-filter.

import { ProfileModel, formatClock } from "./model";
import { FrameData, eventsInRange } from "./frameData";
import { ScoutState, Selection } from "./state";
import { CATEGORIES, INACTIVE_COLOR, INACTIVE_LABEL } from "./categories";
import { activityLabelOf } from "./activityLabel";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Scout renders whole milliseconds; sub-millisecond shows as "< 1". */
export function scoutMs(ms: number): string {
  if (ms > 0 && ms < 1) return "< 1";
  return Math.round(ms).toLocaleString("ru");
}

export function scoutKb(mb: number): string {
  return `${Math.round(mb * 1024).toLocaleString("ru")} КБ`;
}

type MemoryMode = "current" | "average" | "peak";
const MEMORY_MODE_LABEL: Record<MemoryMode, string> = {
  current: "текущая",
  average: "средняя",
  peak: "пиковая"
};

export class SummaryPanel {
  private timeMode: "total" | "average" = "total";
  private memoryMode: MemoryMode = "current";
  private expanded = new Set<string>();

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {}

  private selectionRange(): Selection {
    return this.state.selection ?? { a: 0, b: this.model.frameTimesMs.length - 1 };
  }

  /** top self-time activities of one category inside the selection */
  private topOfCategory(cat: number, aMs: number, bMs: number): { label: string; ms: number }[] {
    const sums = new Map<string, number>();
    eventsInRange(this.model, aMs, bMs, index => {
      if (this.data.eventCat[index] !== cat) return;
      const self = this.data.selfMs[index];
      if (self <= 0) return;
      const label = activityLabelOf(this.model, this.data, index);
      sums.set(label, (sums.get(label) ?? 0) + self);
    });
    return [...sums.entries()]
      .map(([label, ms]) => ({ label, ms }))
      .sort((x, y) => y.ms - x.ms)
      .slice(0, 6);
  }

  render() {
    const { a, b } = this.selectionRange();
    const container = this.container;
    container.textContent = "";
    const frames = b - a + 1;
    const startMs = this.model.frameTimesMs[a] - this.model.frameDtMs[a];
    const endMs = this.model.frameTimesMs[b];
    const spanMs = Math.max(endMs - startMs, 0.001);
    const fps = (frames / spanMs) * 1000;

    let totalMs = 0;
    let activeMs = 0;
    let gpuWaitMs = 0;
    const catTotals = CATEGORIES.map(() => 0);
    for (let f = a; f <= b; f++) {
      totalMs += this.model.frameDtMs[f];
      activeMs += this.data.activeMs[f];
      gpuWaitMs += Math.min(this.data.gpuWaitMs[f], Math.max(this.model.frameDtMs[f] - this.data.activeMs[f], 0));
      CATEGORIES.forEach((_c, cat) => (catTotals[cat] += this.data.catMs[cat][f]));
    }
    const inactiveMs = Math.max(totalMs - activeMs, 0);
    const budgetTotal = this.state.budgetMs() * frames;
    const divisor = this.timeMode === "average" ? frames : 1;

    // ---- header ----------------------------------------------------------
    const header = el("div", "sum-header");
    const left = el("div");
    left.appendChild(el("div", "sum-label", "Частота кадров"));
    left.appendChild(el("div", "sum-fps", `${fps.toFixed(1)} fps`));
    const target = el("div", "sum-label");
    target.appendChild(document.createTextNode("Цель "));
    const targetInput = el("input", "sum-target") as HTMLInputElement;
    targetInput.type = "number";
    targetInput.value = String(this.state.targetFps);
    targetInput.title = "Целевой fps: задаёт красную линию бюджета (1000/fps мс)";
    targetInput.addEventListener("change", () => this.state.setTargetFps(Number(targetInput.value) || 60));
    target.appendChild(targetInput);
    target.appendChild(document.createTextNode(" fps"));
    left.appendChild(target);
    header.appendChild(left);
    const right = el("div", "sum-range");
    right.appendChild(
      el("div", "", frames === 1 ? `Кадр ${a + 1}` : `Кадры ${(a + 1).toLocaleString("ru")} – ${(b + 1).toLocaleString("ru")}`)
    );
    right.appendChild(el("div", "", `Время ${formatClock(startMs)} – ${formatClock(endMs)}`));
    if (!this.state.selection) right.appendChild(el("div", "dim", "вся сессия — выделите диапазон в таймлайне"));
    header.appendChild(right);
    container.appendChild(header);

    // ---- frame time ------------------------------------------------------
    const section = el("div", "sum-section");
    const totalRow = el("div", "sum-row sum-top");
    totalRow.appendChild(el("span", "sum-name", this.timeMode === "average" ? "Среднее время кадра" : "Общее время кадров"));
    totalRow.appendChild(el("span", "sum-value", `${scoutMs(totalMs / divisor)} мс`));
    const gear = el("button", "sum-gear", "⚙");
    gear.title = "Переключить: сумма за выделение / среднее на кадр";
    gear.addEventListener("click", () => {
      this.timeMode = this.timeMode === "total" ? "average" : "total";
      this.render();
    });
    totalRow.appendChild(gear);
    section.appendChild(totalRow);

    const activeRow = el("div", "sum-row");
    activeRow.appendChild(el("span", "sum-name", "Активен"));
    activeRow.appendChild(
      el(
        "span",
        "sum-value",
        `${scoutMs(activeMs / divisor)} = ${Math.round((activeMs / budgetTotal) * 100)} % бюджета ${scoutMs(budgetTotal / divisor)}`
      )
    );
    section.appendChild(activeRow);

    const barMax = Math.max(...catTotals, 1);
    const selectionRange = this.selectionRange();
    const aMs = this.model.frameTimesMs[selectionRange.a] - this.model.frameDtMs[selectionRange.a];
    const bMs = this.model.frameTimesMs[selectionRange.b];

    CATEGORIES.forEach((category, cat) => {
      const filtered = this.state.categoryFilter !== null && this.state.categoryFilter !== cat;
      const row = el("div", `sum-row sum-cat clickable${filtered ? " sum-filtered" : ""}`);
      const expandKey = `cat-${cat}`;
      const arrow = el("span", "sum-arrow", this.expanded.has(expandKey) ? "▼" : "▶");
      arrow.addEventListener("click", event => {
        event.stopPropagation();
        if (this.expanded.has(expandKey)) this.expanded.delete(expandKey);
        else this.expanded.add(expandKey);
        this.render();
      });
      row.appendChild(arrow);
      const chip = el("span", "sum-chip");
      chip.style.background = category.color;
      row.appendChild(chip);
      const name = el("span", "sum-name", category.label);
      name.style.color = filtered ? "" : category.color;
      row.appendChild(name);
      row.appendChild(el("span", "sum-value", scoutMs(catTotals[cat] / divisor)));
      const bar = el("span", "sum-bar");
      const fill = el("span", "sum-bar-fill");
      fill.style.width = `${(catTotals[cat] / barMax) * 100}%`;
      fill.style.background = category.color;
      bar.appendChild(fill);
      row.appendChild(bar);
      row.title = "Клик — фильтровать всё приложение по этой категории";
      row.addEventListener("click", () => {
        this.state.setCategoryFilter(this.state.categoryFilter === cat ? null : cat);
      });
      section.appendChild(row);

      if (this.expanded.has(expandKey)) {
        for (const item of this.topOfCategory(cat, aMs, bMs)) {
          const sub = el("div", "sum-row sum-sub");
          sub.appendChild(el("span", "sum-name", item.label));
          sub.appendChild(el("span", "sum-value", scoutMs(item.ms / divisor)));
          section.appendChild(sub);
        }
      }
    });

    // inactive with the breakdown Scout names in its docs — plus our GPU
    // fence probe actually measuring the "Waiting for GPU" share
    const inactiveKey = "inactive";
    const inactiveRow = el("div", "sum-row sum-inactive clickable");
    const inactiveArrow = el("span", "sum-arrow", this.expanded.has(inactiveKey) ? "▼" : "▶");
    inactiveRow.appendChild(inactiveArrow);
    const inactiveChip = el("span", "sum-chip");
    inactiveChip.style.background = INACTIVE_COLOR;
    inactiveRow.appendChild(inactiveChip);
    inactiveRow.appendChild(el("span", "sum-name", INACTIVE_LABEL));
    inactiveRow.appendChild(el("span", "sum-value", scoutMs(inactiveMs / divisor)));
    inactiveRow.addEventListener("click", () => {
      if (this.expanded.has(inactiveKey)) this.expanded.delete(inactiveKey);
      else this.expanded.add(inactiveKey);
      this.render();
    });
    section.appendChild(inactiveRow);
    if (this.expanded.has(inactiveKey)) {
      const gpu = el("div", "sum-row sum-sub");
      gpu.appendChild(el("span", "sum-name", "Ожидание GPU (fence-датчик)"));
      gpu.appendChild(el("span", "sum-value", scoutMs(gpuWaitMs / divisor)));
      section.appendChild(gpu);
      const rest = el("div", "sum-row sum-sub");
      rest.appendChild(el("span", "sum-name", "Ожидание следующего кадра / прочее"));
      rest.appendChild(el("span", "sum-value", scoutMs(Math.max(inactiveMs - gpuWaitMs, 0) / divisor)));
      section.appendChild(rest);
    }
    container.appendChild(section);

    // ---- memory ----------------------------------------------------------
    const memorySection = el("div", "sum-section");
    let current = NaN;
    for (let f = b; f >= a; f--) {
      if (!Number.isNaN(this.data.memoryMb[f])) {
        current = this.data.memoryMb[f];
        break;
      }
    }
    let sum = 0;
    let count = 0;
    let peak = 0;
    for (let f = a; f <= b; f++) {
      const mb = this.data.memoryMb[f];
      if (Number.isNaN(mb)) continue;
      sum += mb;
      count++;
      if (mb > peak) peak = mb;
    }
    const value =
      this.memoryMode === "current" ? current : this.memoryMode === "average" ? (count ? sum / count : NaN) : peak;

    const memoryRow = el("div", "sum-row sum-top");
    memoryRow.appendChild(el("span", "sum-name", `Память wasm (${MEMORY_MODE_LABEL[this.memoryMode]})`));
    memoryRow.appendChild(el("span", "sum-value", Number.isNaN(value) ? "нет данных" : scoutKb(value)));
    const memoryGear = el("button", "sum-gear", "⚙");
    memoryGear.title = "Переключить: текущая / средняя / пиковая по выделению";
    memoryGear.addEventListener("click", () => {
      this.memoryMode =
        this.memoryMode === "current" ? "average" : this.memoryMode === "average" ? "peak" : "current";
      this.render();
    });
    memoryRow.appendChild(memoryGear);
    memorySection.appendChild(memoryRow);
    memorySection.appendChild(
      el("div", "dim sum-note", "Разбивки памяти по категориям в профиле нет — записывается только общий объём wasm-памяти.")
    );
    container.appendChild(memorySection);
  }
}
