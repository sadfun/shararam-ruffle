import "./style.css";
import { initEngine, openProfile } from "./db";
import { loadProfile, ProfileModel, formatMs } from "./model";
import { Viewport, lowerBound } from "./view";
import { buildFrameData, FrameData } from "./frameData";
import { ScoutState } from "./state";
import { FrameTimeline } from "./frameTimeline";
import { SessionSummary } from "./sessionSummary";
import { SummaryPanel } from "./summaryPanel";
import { TopActivities } from "./topActivities";
import { ActivitySequence } from "./activitySequence";
import { ActionScriptPanel } from "./actionScript";
import { AllocationsPanel } from "./allocationsPanel";
import { ScreenPanel } from "./screenPanel";
import { TraceLogPanel } from "./traceLog";
import { renderSessionInfo } from "./sessionInfoPanel";
import { RenderPanel } from "./renderPanel";
import { SnapshotPreview } from "./snapshots";
import { renderRtmpTab, renderLoadsTab, runSql } from "./tables";

const statusEl = document.getElementById("status")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropHint = document.getElementById("drop-hint")!;
const workspace = document.getElementById("workspace")!;
const sessionInfoEl = document.getElementById("session-info")!;
const tooltip = document.getElementById("tooltip")!;

let model: ProfileModel | null = null;
let data: FrameData | null = null;
let state = new ScoutState();
let viewport = new Viewport();
let timeline: FrameTimeline | null = null;
let strip: SessionSummary | null = null;
let summaryPanel: SummaryPanel | null = null;
let topActivities: TopActivities | null = null;
let sequence: ActivitySequence | null = null;
let actionScript: ActionScriptPanel | null = null;
let allocations: AllocationsPanel | null = null;
let screenPanel: ScreenPanel | null = null;
let traceLog: TraceLogPanel | null = null;
let renderPanel: RenderPanel | null = null;
let preview: SnapshotPreview | null = null;

interface SessionEntry {
  name: string;
  file: File;
}
const sessions: SessionEntry[] = [];
let currentSession = -1;

function status(text: string) {
  statusEl.textContent = text;
}

let redrawQueued = false;
function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    timeline?.draw();
    strip?.draw();
  });
}

let panelsQueued = false;
function queuePanels() {
  if (panelsQueued) return;
  panelsQueued = true;
  requestAnimationFrame(() => {
    panelsQueued = false;
    summaryPanel?.render();
    topActivities?.render();
    sequence?.render();
    actionScript?.render();
    allocations?.render();
    screenPanel?.render();
    traceLog?.render();
    void renderPanel?.render();
  });
}

function showTooltip(clientX: number, clientY: number, text: string) {
  tooltip.hidden = false;
  tooltip.textContent = text;
  tooltip.style.left = `${Math.min(clientX + 14, window.innerWidth - 380)}px`;
  tooltip.style.top = `${Math.min(clientY + 14, window.innerHeight - 160)}px`;
}
function hideTooltip() {
  tooltip.hidden = true;
}

/** replaces a canvas with a fresh clone so old pointer listeners die */
function freshCanvas(id: string): HTMLCanvasElement {
  const old = document.getElementById(id) as HTMLCanvasElement;
  const fresh = old.cloneNode(false) as HTMLCanvasElement;
  old.replaceWith(fresh);
  return fresh;
}

function selectFrameAtSeq(seq: number) {
  if (!model) return;
  const index = model.seq.indexOf(seq);
  if (index < 0) return;
  const frame = Math.min(
    lowerBound(model.frameTimesMs, model.startMs[index]),
    model.frameTimesMs.length - 1
  );
  state.setSelection({ a: frame, b: frame });
  // bring the frame into view
  const center = model.frameTimesMs[frame];
  if (center < viewport.v0 || center > viewport.v1) {
    const span = Math.min(viewport.span(), 5000);
    viewport.setRange(center - span / 2, center + span / 2);
  }
}

function renderSessionList() {
  const container = document.getElementById("side-sessions")!;
  container.textContent = "";
  sessions.forEach((session, index) => {
    const row = document.createElement("div");
    row.className = `session-entry${index === currentSession ? " active" : ""}`;
    const name = document.createElement("span");
    name.textContent = session.name;
    row.appendChild(name);
    row.addEventListener("click", () => {
      if (index !== currentSession) void openFile(session.file);
    });
    container.appendChild(row);
  });
}

function renderSidebarCollectors() {
  if (!model || !data) return;
  const container = document.getElementById("side-collectors")!;
  container.textContent = "";
  const has = (predicate: (cat: string, name: string, source: string) => boolean) =>
    model!.kinds.some(kind => predicate(kind.cat, kind.name, kind.source));
  const rows: [string, boolean][] = [
    ["События Ruffle", has((_c, _n, s) => s === "ruffle")],
    ["Счётчики рендера", has((c, n) => c === "render" && n === "submit_frame")],
    ["GPU-датчик (fence)", has(c => c === "gpu")],
    ["Детектор блокировок", has((c, n) => c === "browser" && n === "stall")],
    ["Запись экрана", model.snapTimesMs.length > 0],
    ["Сэмплер AVM1-стека", data!.samplerBySeq.size > 0],
    ["Счётчики аллокаций", data!.counters.has("avm1_objects")],
    ["Карта команд экрана", data!.screenGrid !== null]
  ];
  for (const [name, present] of rows) {
    const row = document.createElement("div");
    row.className = `collector${present ? "" : " collector-off"}`;
    const mark = document.createElement("span");
    mark.className = "collector-mark";
    mark.textContent = present ? "✓" : "✗";
    row.appendChild(mark);
    const label = document.createElement("span");
    label.textContent = name;
    row.appendChild(label);
    container.appendChild(row);
  }
}

function applyChartToggles() {
  if (!timeline) return;
  const canvas = document.getElementById("timeline-canvas") as HTMLCanvasElement;
  canvas.style.height = `${timeline.preferredHeight()}px`;
  queueRedraw();
}

async function openFile(file: File) {
  try {
    status(`открываю ${file.name}…`);
    await openProfile(file);
    status("читаю события…");
    model = await loadProfile();
    status("строю данные кадров…");
    data = await buildFrameData(model);
    dropHint.hidden = true;
    workspace.hidden = false;

    const existing = sessions.findIndex(
      session => session.name === file.name && session.file.size === file.size
    );
    if (existing >= 0) currentSession = existing;
    else {
      sessions.push({ name: file.name, file });
      currentSession = sessions.length - 1;
    }
    renderSessionList();

    state = new ScoutState();
    viewport = new Viewport();
    viewport.reset(model.durationMs);

    const timelineCanvas = freshCanvas("timeline-canvas");
    const stripCanvas = freshCanvas("strip-canvas");
    timeline = new FrameTimeline(timelineCanvas, viewport, model, data, state, showTooltip, hideTooltip);
    strip = new SessionSummary(stripCanvas, viewport, model, data, state);
    applyChartToggles();

    preview = new SnapshotPreview(
      document.getElementById("preview")!,
      document.getElementById("preview-img") as HTMLImageElement,
      document.getElementById("preview-caption")!,
      model
    );
    if (preview.enabled) preview.showAt(model.snapTimesMs[0]);

    summaryPanel = new SummaryPanel(document.getElementById("page-summary")!, model, data, state);
    topActivities = new TopActivities(document.getElementById("page-top")!, model, data, state);
    sequence = new ActivitySequence(document.getElementById("page-sequence")!, model, data, state);
    topActivities.onActivityFilter = label => {
      sequence!.activityFilter = label;
      sequence!.render();
    };
    actionScript = new ActionScriptPanel(document.getElementById("page-actionscript")!, model, data, state);
    allocations = new AllocationsPanel(document.getElementById("page-alloc")!, model, data, state);
    screenPanel = new ScreenPanel(
      document.getElementById("page-screen")!,
      model,
      data,
      state,
      showTooltip,
      hideTooltip
    );
    traceLog = new TraceLogPanel(document.getElementById("page-trace")!, model, data, state);
    renderPanel = new RenderPanel(document.getElementById("page-render")!, model, state);
    renderSessionInfo(document.getElementById("page-session")!, model, data, file.name);
    renderSidebarCollectors();

    viewport.onChange(queueRedraw);
    state.onSelection(() => {
      queueRedraw();
      queuePanels();
      const selection = state.selection;
      if (selection && model)
        preview?.showAt(model.frameTimesMs[selection.b] - model.frameDtMs[selection.b] / 2);
    });
    state.onFilter(() => {
      queueRedraw();
      queuePanels();
    });
    state.onHover(() => {
      queueRedraw();
      if (state.hoverMs !== null) preview?.showAt(state.hoverMs);
    });

    await Promise.all([
      renderRtmpTab(document.getElementById("page-rtmp")!, model.t0Us, selectFrameAtSeq),
      renderLoadsTab(document.getElementById("page-loads")!, model.t0Us, selectFrameAtSeq)
    ]);

    const started = model.meta.get("started_us");
    const version = model.meta.get("client_version") ?? "?";
    sessionInfoEl.textContent = `${file.name} · v${version}${
      started ? ` · ${new Date(Number(started) / 1000).toLocaleString("ru")}` : ""
    }`;

    const frames = model.frameTimesMs.length;
    const fps = frames > 1 ? (frames / model.durationMs) * 1000 : 0;
    status(
      `${frames.toLocaleString("ru")} кадров · ${model.count.toLocaleString("ru")} событий · ` +
        `${formatMs(model.durationMs)} · средний ${fps.toFixed(1)} fps`
    );

    queuePanels();
    queueRedraw();
  } catch (error) {
    console.error(error);
    status(`ошибка: ${error instanceof Error ? error.message : error}`);
  }
}

// ---- static wiring ---------------------------------------------------------

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});
document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void openFile(file);
});

// tab groups: any .tab-strip[data-group] switches its sibling .tab-pages
document.querySelectorAll<HTMLElement>(".tab-strip[data-group]").forEach(strip_ => {
  const pages = strip_.parentElement!.querySelector(".tab-pages")!;
  strip_.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", () => {
      strip_.querySelectorAll("button").forEach(other => other.classList.toggle("active", other === button));
      pages.querySelectorAll(".tab-page").forEach(page => {
        page.classList.toggle("active", page.id === `page-${button.dataset["tab"]}`);
      });
    });
  });
});

document.getElementById("toggle-memory")!.addEventListener("click", event => {
  if (!timeline) return;
  timeline.showMemory = !timeline.showMemory;
  (event.currentTarget as HTMLElement).classList.toggle("active", timeline.showMemory);
  applyChartToggles();
});
document.getElementById("toggle-events")!.addEventListener("click", event => {
  if (!timeline) return;
  timeline.showEvents = !timeline.showEvents;
  (event.currentTarget as HTMLElement).classList.toggle("active", timeline.showEvents);
  applyChartToggles();
});

const sqlInput = document.getElementById("sql-input") as HTMLTextAreaElement;
const runSqlNow = () => void runSql(document.getElementById("sql-result")!, sqlInput.value);
document.getElementById("sql-run")!.addEventListener("click", runSqlNow);
sqlInput.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runSqlNow();
});

window.addEventListener("resize", () => {
  applyChartToggles();
  queueRedraw();
});
window.addEventListener("keydown", event => {
  if (event.key === "Escape") state.setSelection(null);
});

void initEngine()
  .then(async () => {
    status("выберите файл профиля");
    // ?load=<url> opens a profile served over HTTP (useful for automation
    // and for sharing: `npm run dev` + drop the file into public/).
    const load = new URLSearchParams(location.search).get("load");
    if (load) {
      const response = await fetch(load);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${load}`);
      const blob = await response.blob();
      await openFile(new File([blob], load.split("/").pop() ?? "profile.duckdb"));
    }
  })
  .catch(error => status(`движок не загрузился: ${error}`));
