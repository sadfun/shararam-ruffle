// Scout-style frame-time categories. Colors are lifted from pixel-measured
// Adobe Scout CC screenshots (see SCOUT.md §4); the mapping of our event
// kinds onto Scout's four categories is spelled out here and nowhere else.

import { Kind } from "./model";

export interface Category {
  key: string;
  label: string;
  color: string;
  dim: string;
}

export const CATEGORIES: Category[] = [
  { key: "as", label: "ActionScript", color: "#1096d6", dim: "#2c4a5c" },
  { key: "render", label: "Рендер дисплей-листа", color: "#84aa63", dim: "#42503a" },
  { key: "net", label: "Сеть и загрузка", color: "#deb66b", dim: "#5c5140" },
  { key: "other", label: "Прочее", color: "#de795a", dim: "#5c4038" }
];

export const INACTIVE_LABEL = "Неактивен";
export const INACTIVE_COLOR = "#55585c";
export const BUDGET_COLOR = "#de0c08";
export const SELECT_COLOR = "#219ede";
export const TRACE_COLOR = "#e8a33d";

/**
 * Category of a main-thread event kind, or -1 for events that do not occupy
 * the page's main thread (async network waits, GPU fences, server spans).
 */
export function categoryOfKind(kind: Kind): number {
  if (kind.source === "ruffle") {
    // AVM1 stack samples span the same wall time as the script spans they
    // sample, and the screen grid is bookkeeping — never main-thread work.
    if (kind.cat === "sampler") return -1;
    if (kind.cat === "render" && kind.name === "screen_grid") return -1;
    switch (kind.cat) {
      case "script":
      case "input":
      case "external":
        return 0;
      case "render":
      case "text":
      case "asset":
        return 1;
      case "swf":
      case "load":
      case "net":
      case "rtmp":
        return 2;
      case "frame":
      case "gc":
      case "profiler":
        return 3;
      case "http": // async fetch latency, not main-thread time
        return -1;
      default:
        return 3;
    }
  }
  if (kind.source === "browser") {
    if (kind.cat === "browser" && kind.name === "stall") return 3;
    if (kind.cat === "rec") return 3;
    return -1; // gpu/fence_wait, http/resource, markers
  }
  return -1;
}

// Display names in Scout's activity vocabulary (SCOUT.md §5.5), translated.
const ACTIVITY_NAMES: Record<string, string> = {
  "frame/host_tick": "Тик хоста (оверхед рантайма)",
  "frame/tick": "Тик Ruffle",
  "frame/run_frame": "Выполнение кадра SWF",
  "script/run_actions": "Выполнение AS-действий",
  "script/avm1_frame": "AS, привязанный к кадру",
  "script/timers": "Событие \"timer\"",
  "script/goto": "Переход по кадрам (goto)",
  "script/rtmp_invoke": "RTMP-вызов",
  "script/rtmp_responder": "RTMP-ответ (responder)",
  "script/rtmp_connected": "RTMP-подключение",
  "script/load_vars_on_data": "LoadVars: onData",
  "script/array_sort": "Array.sort (нативная сортировка)",
  "input/mouse_pick": "Hit-тест кнопок",
  "input/handle_event": "Обработка события",
  "external/call_out": "ExternalInterface",
  "gc/collect": "Сборка мусора",
  "render/render": "Рендер дисплей-листа",
  "render/submit": "Сабмит кадра в wgpu",
  "render/submit_frame": "Сборка рендер-команд",
  "render/register_shape": "Тесселяция шейпа",
  "render/create_empty_texture": "Создание текстуры",
  "render/viewport": "Смена вьюпорта",
  "render/debug_info": "Отладочная информация рендера",
  "text/relayout": "Layout текста",
  "asset/bitmap_decode": "Декодирование изображения",
  "swf/preload_chunk": "Прелоад SWF (чанк тегов)",
  "swf/define_font": "Определение шрифта (DefineFont)",
  "load/preload": "Прелоад SWF",
  "load/preload_tick": "Тик прелоада",
  "load/movie_data": "Приём данных SWF",
  "load/movie_cache_hit": "Загрузка SWF: из кэша распарсенных",
  "load/movie_complete": "Загрузка SWF: завершена",
  "load/movie_load_start": "Загрузка SWF: старт",
  "load/movie_init_queued": "Загрузка SWF: в очереди",
  "load/root_movie": "Корневой SWF",
  "net/streams": "Обработка NetStream",
  "net/update_net_connections": "Обработка NetConnection",
  "net/update_sockets": "Обработка сокетов",
  "rtmp/data_in": "Приём RTMP-данных",
  "rtmp/recv": "RTMP: входящая команда",
  "rtmp/send": "RTMP: исходящая команда",
  "http/fetch": "Сетевой запрос",
  "browser/stall": "Блокировка потока (неинструментировано)",
  "rec/capture": "Захват кадра записи экрана",
  "profiler/installed": "Профайлер установлен",
  "sampler/avm1": "Сэмпл AVM1-стека",
  "render/screen_grid": "Карта команд экрана"
};

export function activityName(kind: Kind): string {
  return ACTIVITY_NAMES[`${kind.cat}/${kind.name}`] ?? `${kind.cat}/${kind.name}`;
}
