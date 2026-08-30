// Session Info: profile metadata plus an honest list of which collectors
// actually recorded data in this session (the analog of Scout's telemetry
// settings, derived from the data itself).

import { ProfileModel, formatMs } from "./model";
import { FrameData } from "./frameData";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const META_LABELS: Record<string, string> = {
  started_us: "Начало записи",
  client_version: "Версия клиента",
  platform: "Платформа",
  arch: "Архитектура",
  user_agent: "User agent",
  device_pixel_ratio: "Pixel ratio",
  screen: "Экран",
  hardware_concurrency: "Ядер CPU",
  profile_path: "Файл профиля",
  recording_fps: "Запись экрана, к/с"
};

export function renderSessionInfo(
  container: HTMLElement,
  model: ProfileModel,
  data: FrameData,
  fileName: string
) {
  container.textContent = "";
  const section = el("div", "info-section");
  section.appendChild(el("div", "info-title", fileName));

  const table = el("table", "grid") as HTMLTableElement;
  const body = table.createTBody();
  const addRow = (name: string, value: string) => {
    const tr = body.insertRow();
    tr.insertCell().textContent = name;
    const td = tr.insertCell();
    td.textContent = value;
    td.className = "info-value";
  };
  for (const [key, value] of model.meta) {
    if (key === "started_us" || key === "page_origin_us") {
      if (key === "started_us")
        addRow(META_LABELS[key], new Date(Number(value) / 1000).toLocaleString("ru"));
      continue;
    }
    addRow(META_LABELS[key] ?? key, value);
  }
  addRow("Длительность", formatMs(model.durationMs));
  addRow("Кадров (rAF)", model.frameTimesMs.length.toLocaleString("ru"));
  addRow("Событий", model.count.toLocaleString("ru"));
  section.appendChild(table);
  container.appendChild(section);

  // which collectors produced data — the Scout sidebar checklist, but
  // derived from what is actually in the file
  const collectors = el("div", "info-section");
  collectors.appendChild(el("div", "info-title", "Что записано"));
  const has = (predicate: (cat: string, name: string, source: string) => boolean) =>
    model.kinds.some(kind => predicate(kind.cat, kind.name, kind.source));
  const rows: [string, boolean, string][] = [
    ["События Ruffle (форк)", has((_c, _n, s) => s === "ruffle"), "фазы кадра, скрипты, рендер, загрузки"],
    ["Счётчики рендера", has((c, n) => c === "render" && n === "submit_frame"), "args тиков: шейпы, бленды, cacheAsBitmap…"],
    ["GPU-датчик (fence)", has(c => c === "gpu"), "ожидание GPU каждый кадр"],
    ["Детектор блокировок", has((c, n) => c === "browser" && n === "stall"), "паузы главного потока ≥ ~30 мс"],
    ["Запись экрана", model.snapTimesMs.length > 0, `${model.snapTimesMs.length} кадров JPEG`],
    ["Трейсы игры", data.traces.length > 0, `${data.traces.length} строк (ExternalInterface)`],
    [
      "Сэмплер AVM1-стека",
      data.samplerBySeq.size > 0,
      data.samplerBySeq.size > 0
        ? `${data.samplerBySeq.size.toLocaleString("ru")} сэмплов (~1 мс)`
        : "нужен бандл web-profiler от 30.08+"
    ],
    [
      "Счётчики аллокаций",
      data.counters.has("avm1_objects"),
      data.counters.has("avm1_objects")
        ? "объекты/массивы/функции AVM1 + куча gc-arena"
        : "нужен бандл web-profiler от 30.08+"
    ],
    [
      "Карта команд экрана",
      data.screenGrid !== null,
      data.screenGrid !== null ? "сетка 24×18 + бленды/маски" : "нужен бандл web-profiler от 30.08+"
    ],
    ["CPU Usage", false, "не записывается этой сборкой"]
  ];
  const list = el("div", "collector-list");
  for (const [name, present, note] of rows) {
    const row = el("div", `collector${present ? "" : " collector-off"}`);
    row.appendChild(el("span", "collector-mark", present ? "✓" : "✗"));
    row.appendChild(el("span", "", name));
    row.appendChild(el("span", "dim collector-note", note));
    list.appendChild(row);
  }
  collectors.appendChild(list);
  container.appendChild(collectors);
}
