import "./style.css";
import { initEngine, openProfile } from "./db";
import { loadProfile, ProfileModel, formatMs } from "./model";
import { Viewport, attachNavigation } from "./view";
import { FpsChart, LEFT_GUTTER } from "./fps";
import { Timeline } from "./timeline";
import { renderRtmpTab, renderLoadsTab, renderSlowTab, renderDetails, runSql } from "./tables";

const statusEl = document.getElementById("status")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const dropHint = document.getElementById("drop-hint")!;
const workspace = document.getElementById("workspace")!;
const sessionInfo = document.getElementById("session-info")!;
const tooltip = document.getElementById("tooltip")!;

let model: ProfileModel | null = null;
let viewport = new Viewport();
let fpsChart: FpsChart | null = null;
let timeline: Timeline | null = null;
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
    timeline?.draw();
  });
}

async function selectEvent(seq: number) {
  if (!model) return;
  activateTab("details");
  await renderDetails(document.getElementById("details")!, seq, model.t0Us);
  // highlight on the timeline
  if (timeline) {
    const index = model.seq.indexOf(seq);
    timeline.selectedIndex = index;
    queueRedraw();
  }
}

function activateTab(name: string) {
  document.querySelectorAll<HTMLElement>("#tabs button").forEach(button => {
    button.classList.toggle("active", button.dataset["tab"] === name);
  });
  document.querySelectorAll<HTMLElement>(".tab").forEach(tab => {
    tab.classList.toggle("active", tab.id === `tab-${name}`);
  });
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
    const timelineCanvas = document.getElementById("timeline-canvas") as HTMLCanvasElement;
    fpsChart = new FpsChart(fpsCanvas, viewport, model);
    timeline = new Timeline(timelineCanvas, viewport, model);
    timelineCanvas.style.height = `${timeline.preferredHeight()}px`;

    viewport.onChange(queueRedraw);
    attachNavigation(fpsCanvas, viewport, LEFT_GUTTER);
    attachNavigation(timelineCanvas, viewport, LEFT_GUTTER, (x, y) => {
      const index = timeline!.hitTest(x, y);
      if (index >= 0) void selectEvent(model!.seq[index]);
    });
    timelineCanvas.addEventListener("pointermove", event => {
      const rect = timelineCanvas.getBoundingClientRect();
      const index = timeline!.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (index !== timeline!.hoveredIndex) {
        timeline!.hoveredIndex = index;
        queueRedraw();
      }
      if (index >= 0) {
        tooltip.hidden = false;
        tooltip.textContent = timeline!.describe(index);
        tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 340)}px`;
        tooltip.style.top = `${event.clientY + 14}px`;
      } else {
        tooltip.hidden = true;
      }
    });
    timelineCanvas.addEventListener("pointerleave", () => {
      tooltip.hidden = true;
      if (timeline) {
        timeline.hoveredIndex = -1;
        queueRedraw();
      }
    });

    document.getElementById("fps-summary")!.textContent = fpsChart.summary();
    document.getElementById("event-summary")!.textContent =
      `${model.count.toLocaleString("ru")} событий · ${formatMs(model.durationMs)}`;
    const started = model.meta.get("started_us");
    const version = model.meta.get("client_version") ?? "?";
    sessionInfo.textContent = `${file.name} · v${version}${
      started ? ` · ${new Date(Number(started) / 1000).toLocaleString("ru")}` : ""
    }`;

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
