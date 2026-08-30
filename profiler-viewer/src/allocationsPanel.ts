// Аллокации — the analog of Scout's Memory Allocations panel, built from
// what the fork actually records: per-frame creation counters by type
// (script objects, arrays, function objects, display objects, renderer
// uploads), the gc-arena heap gauge, and — when the AVM1 sampler is on —
// which stacks were executing while objects were created (Scout's
// allocation backtraces, at ~1 ms granularity).

import { ProfileModel, formatBytes } from "./model";
import { FrameData, eventsInRange } from "./frameData";
import { ScoutState } from "./state";
import { CATEGORIES } from "./categories";
import { scoutMs } from "./summaryPanel";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** [counter key, label, indent] — indented rows are subsets of the first. */
const COUNTER_ROWS: [string, string, boolean][] = [
  ["avm1_objects", "Объекты AVM1 (все скрипт-объекты)", false],
  ["avm1_arrays", "из них массивы", true],
  ["avm1_functions", "из них функции и замыкания", true],
  ["objects_instantiated", "Дисплей-объекты (клипы, поля…)", false],
  ["shapes_registered", "Тесселяции шейпов", false],
  ["bitmaps_registered", "Загрузки текстур", false],
  ["bitmaps_decoded", "Декодирования битмапов", false],
  ["text_layouts", "Layout текста", false]
];

export class AllocationsPanel {
  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {}

  render() {
    const container = this.container;
    container.textContent = "";
    const hasCounters = this.data.counters.has("avm1_objects");
    const hasGc = this.data.gcHeapMaxMb > 0;
    if (!hasCounters && !hasGc) {
      container.appendChild(
        el(
          "div",
          "details-empty",
          "Счётчики аллокаций не записаны в этом профиле. Нужна профилировочная " +
            "сборка с бандлом web-profiler от 30.08+ — она считает создания " +
            "объектов по типам и размер кучи gc-arena каждый кадр."
        )
      );
      return;
    }

    const frameCount = this.model.frameTimesMs.length;
    const selection = this.state.selection ?? { a: 0, b: frameCount - 1 };
    const frames = selection.b - selection.a + 1;
    let rangeMs = 0;
    for (let f = selection.a; f <= selection.b; f++) rangeMs += this.model.frameDtMs[f];

    const toolbar = el("div", "panel-toolbar");
    toolbar.appendChild(el("span", "dim", this.state.selection ? `кадры ${selection.a} – ${selection.b}` : "вся сессия — выделите диапазон"));
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(el("span", "dim", `${scoutMs(rangeMs)} мс`));
    container.appendChild(toolbar);

    if (hasCounters) {
      const table = el("table", "grid") as HTMLTableElement;
      const head = table.createTHead().insertRow();
      head.appendChild(el("th", "", "Создано"));
      head.appendChild(el("th", "num", "всего"));
      head.appendChild(el("th", "num", "/ кадр"));
      head.appendChild(el("th", "num", "/ с"));
      const body = table.createTBody();
      for (const [key, label, indent] of COUNTER_ROWS) {
        const series = this.data.counters.get(key);
        if (!series) continue;
        let total = 0;
        for (let f = selection.a; f <= selection.b; f++) total += series[f];
        const tr = body.insertRow();
        const name = tr.insertCell();
        name.textContent = label;
        if (indent) {
          name.style.paddingLeft = "24px";
          name.className = "dim";
        }
        const sum = tr.insertCell();
        sum.className = "num";
        sum.textContent = total.toLocaleString("ru");
        const perFrame = tr.insertCell();
        perFrame.className = "num dim";
        perFrame.textContent = frames ? (total / frames).toFixed(total / frames >= 10 ? 0 : 1) : "";
        const perSecond = tr.insertCell();
        perSecond.className = "num dim";
        perSecond.textContent = rangeMs > 0 ? Math.round((total / rangeMs) * 1000).toLocaleString("ru") : "";
      }
      container.appendChild(table);
    }

    // gc heap + wasm memory over the range
    const memory = el("div", "info-section");
    memory.appendChild(el("div", "info-title", "Память за диапазон"));
    const memTable = el("table", "grid") as HTMLTableElement;
    const memBody = memTable.createTBody();
    const addMemRow = (label: string, series: Float64Array, maxMb: number) => {
      const first = series[selection.a];
      const last = series[selection.b];
      if (Number.isNaN(first) && Number.isNaN(last)) return;
      let peak = 0;
      for (let f = selection.a; f <= selection.b; f++) {
        if (!Number.isNaN(series[f]) && series[f] > peak) peak = series[f];
      }
      const tr = memBody.insertRow();
      tr.insertCell().textContent = label;
      const value = tr.insertCell();
      value.className = "num";
      const delta = last - first;
      const fmt = (mb: number) => (Number.isNaN(mb) ? "—" : formatBytes(mb * 1048576));
      value.textContent = `${fmt(first)} → ${fmt(last)}`;
      const deltaCell = tr.insertCell();
      deltaCell.className = "num";
      deltaCell.textContent = Number.isNaN(delta) ? "" : `${delta >= 0 ? "+" : ""}${formatBytes(delta * 1048576)}`;
      if (!Number.isNaN(delta)) deltaCell.style.color = delta > 1 ? "#de795a" : "#84aa63";
      const peakCell = tr.insertCell();
      peakCell.className = "num dim";
      peakCell.textContent = `пик ${formatBytes(peak * 1048576)} (сессия ${formatBytes(maxMb * 1048576)})`;
    };
    if (hasGc) addMemRow("Куча gc-arena", this.data.gcHeapMb, this.data.gcHeapMaxMb);
    addMemRow("Память wasm", this.data.memoryMb, this.data.memoryMaxMb);
    memory.appendChild(memTable);
    container.appendChild(memory);

    // allocation backtraces from the sampler
    if (this.data.samplerBySeq.size) {
      const aMs = this.model.frameTimesMs[selection.a] - this.model.frameDtMs[selection.a];
      const bMs = this.model.frameTimesMs[selection.b];
      interface StackRow {
        stack: string;
        alloc: number;
        ms: number;
      }
      const byStack = new Map<string, StackRow>();
      const kinds = this.model.kinds;
      eventsInRange(this.model, aMs, bMs, index => {
        const kind = kinds[this.model.kindIds[index]];
        if (kind.source !== "ruffle" || kind.cat !== "sampler") return;
        const info = this.data.samplerBySeq.get(this.model.seq[index]);
        if (!info || !info.alloc) return;
        // group by the tail of the stack — the function that allocated
        const frames = info.stack.split(" / ");
        const tail = frames.slice(-3).join(" / ");
        let row = byStack.get(tail);
        if (!row) byStack.set(tail, (row = { stack: tail, alloc: 0, ms: 0 }));
        row.alloc += info.alloc;
        row.ms += this.model.durMs[index];
      });
      const top = [...byStack.values()].sort((x, y) => y.alloc - x.alloc).slice(0, 12);
      if (top.length) {
        const section = el("div", "info-section");
        section.appendChild(el("div", "info-title", "Кто аллоцирует (по сэмплам стека)"));
        const table = el("table", "grid") as HTMLTableElement;
        const head = table.createTHead().insertRow();
        head.appendChild(el("th", "", "Стек (хвост)"));
        head.appendChild(el("th", "num", "объектов"));
        head.appendChild(el("th", "num", "мс"));
        const body = table.createTBody();
        for (const row of top) {
          const tr = body.insertRow();
          const name = tr.insertCell();
          name.textContent = row.stack;
          name.style.color = CATEGORIES[0].color;
          const alloc = tr.insertCell();
          alloc.className = "num";
          alloc.textContent = row.alloc.toLocaleString("ru");
          const ms = tr.insertCell();
          ms.className = "num dim";
          ms.textContent = scoutMs(row.ms);
        }
        section.appendChild(table);
        container.appendChild(section);
      }
    }

    container.appendChild(
      el(
        "div",
        "dim panel-note",
        "Счётчики — число созданий, не байты; массивы и функции входят и в общий " +
          "счётчик объектов. Строки (AvmString) не инструментированы. Кривая кучи " +
          "gc-arena рисуется на графике «Память» таймлайна."
      )
    );
  }
}
