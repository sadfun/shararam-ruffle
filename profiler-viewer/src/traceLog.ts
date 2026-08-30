// Trace Log: the game's console output (ExternalInterface console.log —
// Shararam's equivalent of trace()) for the selected frames, in Scout's
// light-grey monospace field. Click a line to jump to its frame.

import { ProfileModel, formatClock } from "./model";
import { FrameData } from "./frameData";
import { ScoutState } from "./state";
import { lowerBound } from "./view";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TraceLogPanel {
  showTimestamps = true;
  findText = "";
  private findFocused = false;

  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private data: FrameData,
    private state: ScoutState
  ) {}

  render() {
    const container = this.container;
    container.textContent = "";
    const selection = this.state.selection;
    const aMs = selection
      ? this.model.frameTimesMs[selection.a] - this.model.frameDtMs[selection.a]
      : -Infinity;
    const bMs = selection ? this.model.frameTimesMs[selection.b] : Infinity;

    const toolbar = el("div", "panel-toolbar");
    const toggle = el("button", `mini-button${this.showTimestamps ? " active" : ""}`, "⏱ время");
    toggle.addEventListener("click", () => {
      this.showTimestamps = !this.showTimestamps;
      this.render();
    });
    toolbar.appendChild(toggle);
    const find = document.createElement("input");
    find.className = "find-input";
    find.placeholder = "найти…";
    find.value = this.findText;
    find.addEventListener("input", () => {
      this.findText = find.value;
      this.render();
    });
    find.addEventListener("focus", () => (this.findFocused = true));
    find.addEventListener("blur", () => (this.findFocused = false));
    toolbar.appendChild(find);
    if (this.findFocused) {
      queueMicrotask(() => {
        find.focus();
        find.setSelectionRange(find.value.length, find.value.length);
      });
    }
    toolbar.appendChild(el("span", "spacer"));
    toolbar.appendChild(el("span", "dim", selection ? "trace из выделения" : "trace всей сессии"));
    container.appendChild(toolbar);

    const needle = this.findText.trim().toLowerCase();
    const field = el("div", "trace-field");
    let shown = 0;
    for (const trace of this.data.traces) {
      if (trace.tsMs < aMs || trace.tsMs > bMs) continue;
      if (needle && !trace.text.toLowerCase().includes(needle)) continue;
      shown++;
      const line = el("div", "trace-line");
      if (this.showTimestamps) line.appendChild(el("span", "trace-ts", formatClock(trace.tsMs)));
      line.appendChild(el("span", "", trace.text));
      line.title = "Клик — выделить кадр этой строки";
      line.addEventListener("click", () => {
        const index = Math.min(
          lowerBound(this.model.frameTimesMs, trace.tsMs),
          this.model.frameTimesMs.length - 1
        );
        this.state.setSelection({ a: index, b: index });
      });
      field.appendChild(line);
    }
    if (!shown)
      field.appendChild(
        el(
          "div",
          "trace-empty",
          needle ? "ничего не найдено" : selection ? "в выделении trace-строк нет" : "trace-строк нет"
        )
      );
    container.appendChild(field);
  }
}
