import "./style.css";
import { initEngine, openProfile } from "./db";
import { loadProfile, ProfileModel, formatMs } from "./model";
import { Viewport, attachNavigation } from "./view";
import { FpsChart, LEFT_GUTTER } from "./fps";
import { Timeline } from "./timeline";
import { FrameStrip } from "./frames";
import { SnapshotPreview } from "./snapshots";
import {
  renderRtmpTab,
  renderLoadsTab,
  renderSlowTab,
  renderFramesTab,
  renderFrameDetails,
  renderDetails,
  runSql
} from "./tables";

const statusEl = document.getElementById("status")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropHint = document.getElementById("drop-hint")!;
const workspace = document.getElementById("workspace")!;
const sessionInfo = document.getElementById("session-info")!;
const tooltip = document.getElementById("tooltip")!;
const slowThreshold = document.getElementById("slow-threshold") as HTMLSelectElement;

let model: ProfileModel | null = null;
let viewport = new Viewport();
let fpsChart: FpsChart | null = null;
let frameStrip: FrameStrip | null = null;
let timeline: Timeline | null = null;
let preview: SnapshotPreview | null = null;
let redrawQueued = false;

function status(text: string) {
  statusEl.textContent = text;
}

function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    fpsChart?.draw();
    frameStrip?.draw();
    timeline?.draw();
  });
}

function activateTab(name: string) {
  document.querySelectorAll<HTMLElement>("#tabs button").forEach(button => {
    button.classList.toggle("active", button.dataset["tab"] === name);
  });
  document.querySelectorAll<HTMLElement>(".tab").forEach(tab => {
    tab.classList.toggle("active", tab.id === `tab-${name}`);
  });
}

/** Scrub position shared by all charts + the recording preview. */
function setCursor(ms: number | null) {
  if (fpsChart) fpsChart.cursorMs = ms;
  if (frameStrip) frameStrip.cursorMs = ms;
  if (timeline) timeline.cursorMs = ms;
  if (ms !== null) preview?.showAt(ms);
  queueRedraw();
}

async function selectEvent(seq: number) {
  if (!model) return;
  activateTab("details");
  await renderDetails(document.getElementById("details")!, seq, model.t0Us);
  if (timeline) {
    const index = model.seq.indexOf(seq);
    timeline.selectedIndex = index;
    if (index >= 0) preview?.showAt(model.startMs[index]);
    queueRedraw();
  }
}

function zoomToFrame(index: number) {
  if (!model || !frameStrip) return;
  const [start, end] = frameStrip.frameSpan(index);
  const span = Math.max((end - start) * 8, 200);
  const center = (start + end) / 2;
  viewport.setRange(center - span / 2, center + span / 2);
}

async function selectFrame(index: number, ensureVisible = false) {
  if (!model || !frameStrip || !timeline) return;
  frameStrip.selectedIndex = index;
  timeline.selectedIndex = -1;
  const span = frameStrip.frameSpan(index);
  timeline.highlightSpan = span;
  if (ensureVisible && (span[0] < viewport.v0 || span[1] > viewport.v1 || viewport.span() > 5000)) {
    const width = Math.max(Math.min(viewport.span(), 2000), (span[1] - span[0]) * 8);
    const center = (span[0] + span[1]) / 2;
    viewport.setRange(center - width / 2, center + width / 2);
  }
  preview?.showAt((span[0] + span[1]) / 2);
  activateTab("details");
  await renderFrameDetails(
    document.getElementById("details")!,
    model,
    index,
    seq => void selectEvent(seq),
    () => zoomToFrame(index)
  );
  queueRedraw();
}

function jumpSlow(direction: 1 | -1) {
  if (!model || !frameStrip) return;
  const threshold = Number(slowThreshold.value);
  const list = frameStrip.slowFrames(threshold);
  if (!list.length) {
    status(`кадров дольше ${threshold} мс нет`);
    return;
  }
  let current = frameStrip.selectedIndex;
  if (current < 0) {
    // start from the middle of the current view
    const centerMs = (viewport.v0 + viewport.v1) / 2;
    const times = model.frameTimesMs;
    let low = 0;
    let high = times.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (times[mid] < centerMs) low = mid + 1;
      else high = mid;
    }
    current = direction > 0 ? low - 1 : low;
  }
  let target: number | undefined;
  if (direction > 0) {
    target = list.find(i => i > current);
  } else {
    for (const i of list) {
      if (i < current) target = i;
      else break;
    }
  }
  if (target === undefined) {
    status(direction > 0 ? "дальше медленных кадров нет" : "раньше медленных кадров нет");
    return;
  }
  void selectFrame(target, true);
}

function updateFramesSummary() {
  if (!model || !frameStrip) return;
  const threshold = Number(slowThreshold.value);
  const slow = frameStrip.slowFrames(threshold).length;
  document.getElementById("frames-summary")!.textContent =
    `${model.frameTimesMs.length.toLocaleString("ru")} кадров · дольше ${threshold} мс: ${slow.toLocaleString("ru")}` +
    (model.snapTimesMs.length
      ? ` · запись экрана: ${model.snapTimesMs.length.toLocaleString("ru")} кадров`
      : "");
}

function msAt(canvas: HTMLCanvasElement, clientX: number): number {
  const rect = canvas.getBoundingClientRect();
  return viewport.msOf(clientX - rect.left - LEFT_GUTTER, rect.width - LEFT_GUTTER);
}

function showTooltip(clientX: number, clientY: number, text: string) {
  tooltip.hidden = false;
  tooltip.textContent = text;
  tooltip.style.left = `${Math.min(clientX + 14, window.innerWidth - 340)}px`;
  tooltip.style.top = `${clientY + 14}px`;
}

async function openFile(file: File) {
  try {
    status(`открываю ${file.name}…`);
    await openProfile(file);
    status("читаю события…");
    model = await loadProfile();
    dropHint.hidden = true;
    workspace.hidden = false;

    viewport = new Viewport();
    viewport.reset(model.durationMs);

    const fpsCanvas = document.getElementById("fps-canvas") as HTMLCanvasElement;
    const stripCanvas = document.getElementById("frame-strip") as HTMLCanvasElement;
    const timelineCanvas = document.getElementById("timeline-canvas") as HTMLCanvasElement;
    fpsChart = new FpsChart(fpsCanvas, viewport, model);
    frameStrip = new FrameStrip(stripCanvas, viewport, model);
    timeline = new Timeline(timelineCanvas, viewport, model);
    timelineCanvas.style.height = `${timeline.preferredHeight()}px`;
    preview = new SnapshotPreview(
      document.getElementById("preview")!,
      document.getElementById("preview-img") as HTMLImageElement,
      document.getElementById("preview-caption")!,
      model
    );
    if (preview.enabled) preview.showAt(model.snapTimesMs[0]);

    viewport.onChange(queueRedraw);
    attachNavigation(fpsCanvas, viewport, LEFT_GUTTER);
    attachNavigation(stripCanvas, viewport, LEFT_GUTTER, x => {
      const index = frameStrip!.hitFrame(x);
      if (index >= 0) void selectFrame(index);
    });
    attachNavigation(timelineCanvas, viewport, LEFT_GUTTER, (x, y) => {
      const index = timeline!.hitTest(x, y);
      if (index >= 0) void selectEvent(model!.seq[index]);
    });

    // hover: scrub cursor + recording preview on every chart
    fpsCanvas.addEventListener("pointermove", event => {
      setCursor(msAt(fpsCanvas, event.clientX));
    });
    fpsCanvas.addEventListener("pointerleave", () => setCursor(null));

    stripCanvas.addEventListener("pointermove", event => {
      const rect = stripCanvas.getBoundingClientRect();
      const index = frameStrip!.hitFrame(event.clientX - rect.left);
      if (index !== frameStrip!.hoveredIndex) frameStrip!.hoveredIndex = index;
      if (index >= 0) showTooltip(event.clientX, event.clientY, frameStrip!.describe(index));
      else tooltip.hidden = true;
      setCursor(msAt(stripCanvas, event.clientX));
    });
    stripCanvas.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
      if (frameStrip) frameStrip.hoveredIndex = -1;
      setCursor(null);
    });

    timelineCanvas.addEventListener("pointermove", event => {
      const rect = timelineCanvas.getBoundingClientRect();
      const index = timeline!.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (index !== timeline!.hoveredIndex) timeline!.hoveredIndex = index;
      if (index >= 0) showTooltip(event.clientX, event.clientY, timeline!.describe(index));
      else tooltip.hidden = true;
      setCursor(msAt(timelineCanvas, event.clientX));
    });
    timelineCanvas.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
      if (timeline) timeline.hoveredIndex = -1;
      setCursor(null);
    });

    document.getElementById("fps-summary")!.textContent = fpsChart.summary();
    document.getElementById("event-summary")!.textContent =
      `${model.count.toLocaleString("ru")} событий · ${formatMs(model.durationMs)}`;
    updateFramesSummary();
    const started = model.meta.get("started_us");
    const version = model.meta.get("client_version") ?? "?";
    sessionInfo.textContent = `${file.name} · v${version}${
      started ? ` · ${new Date(Number(started) / 1000).toLocaleString("ru")}` : ""
    }`;

    renderFramesTab(document.getElementById("frames-table")!, model, index =>
      void selectFrame(index, true)
    );
    await Promise.all([
      renderRtmpTab(document.getElementById("rtmp-table")!, model.t0Us, selectEvent),
      renderLoadsTab(document.getElementById("loads-table")!, model.t0Us, selectEvent),
      renderSlowTab(document.getElementById("slow-table")!, model.t0Us, selectEvent)
    ]);

    status("готово");
    queueRedraw();
  } catch (error) {
    console.error(error);
    status(`ошибка: ${error instanceof Error ? error.message : error}`);
  }
}

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

document.querySelectorAll<HTMLElement>("#tabs button").forEach(button => {
  button.addEventListener("click", () => activateTab(button.dataset["tab"]!));
});

document.getElementById("prev-slow")!.addEventListener("click", () => jumpSlow(-1));
document.getElementById("next-slow")!.addEventListener("click", () => jumpSlow(1));
slowThreshold.addEventListener("change", updateFramesSummary);

const sqlInput = document.getElementById("sql-input") as HTMLTextAreaElement;
const runSqlNow = () => void runSql(document.getElementById("sql-result")!, sqlInput.value);
document.getElementById("sql-run")!.addEventListener("click", runSqlNow);
sqlInput.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runSqlNow();
});

window.addEventListener("resize", queueRedraw);

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
