// «Рендер кадра» — our stand-in for Scout's DisplayList Rendering panel.
// For a single selected frame: the render-command counters the instrumented
// build wrote into that frame's tick args, plus every render-side activity
// of the frame (tessellations with their source SWF, texture uploads,
// bitmap decodes). The fork does not record screen geometry, so there is no
// heat map / regions view — that omission is stated in the panel.

import { query, toNumber } from "./db";
import { ProfileModel, formatClock, formatMs } from "./model";
import { ScoutState } from "./state";

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const COUNTERS: { key: string; label: string; src: "sa" | "ra" }[] = [
  { key: "commands", label: "Команды рендера", src: "sa" },
  { key: "shapes", label: "Шейпы в кадре", src: "sa" },
  { key: "bitmaps", label: "Битмапы в кадре", src: "sa" },
  { key: "rects", label: "Прямоугольники", src: "sa" },
  { key: "stencil_masks", label: "Stencil-маски", src: "sa" },
  { key: "alpha_masks", label: "Alpha-маски", src: "sa" },
  { key: "blend_layer", label: "Layer-бленды", src: "sa" },
  { key: "blend_complex", label: "Сложные бленды", src: "sa" },
  { key: "blend_multiply_direct", label: "Multiply без снимка бэкдропа", src: "sa" },
  { key: "blend_shader", label: "Shader-бленды", src: "sa" },
  { key: "cache_commands", label: "cacheAsBitmap: команды", src: "sa" },
  { key: "cache_entries", label: "cacheAsBitmap: записей в кэше", src: "sa" },
  { key: "display_objects", label: "Объекты сцены", src: "ra" },
  { key: "offscreen_renders", label: "Оффскрин-рендеры", src: "ra" },
  { key: "layer_blends_inlined", label: "Инлайн-бленды", src: "ra" },
  { key: "textures_updated", label: "Обновления текстур", src: "ra" },
  { key: "shapes_registered", label: "Тесселяции шейпов", src: "ra" },
  { key: "bitmaps_registered", label: "Новые битмапы", src: "ra" },
  { key: "bitmaps_decoded", label: "Декодирования битмапов", src: "ra" },
  { key: "text_layouts", label: "Layout текста", src: "ra" },
  { key: "objects_instantiated", label: "Создано объектов", src: "ra" }
];

export class RenderPanel {
  constructor(
    private container: HTMLElement,
    private model: ProfileModel,
    private state: ScoutState
  ) {}

  async render() {
    const container = this.container;
    container.textContent = "";
    const selection = this.state.selection;
    if (!selection || selection.a !== selection.b) {
      container.appendChild(
        el("div", "details-empty", "Разбор рендера показывается для одного кадра: кликните по кадру в таймлайне.")
      );
      return;
    }
    const frame = selection.a;
    const endMs = this.model.frameTimesMs[frame];
    const dtMs = this.model.frameDtMs[frame];
    const startUs = Math.round(this.model.t0Us + (endMs - dtMs) * 1000);
    const endUs = Math.round(this.model.t0Us + endMs * 1000);

    container.appendChild(
      el("div", "panel-toolbar", `кадр @${formatClock(endMs - dtMs)} · ${formatMs(dtMs)}`)
    );

    let rows;
    try {
      ({ rows } = await query(
        `SELECT name, args, ts_us, dur_us FROM events
         WHERE cat = 'render' AND ts_us >= ${startUs} AND ts_us < ${endUs}
         ORDER BY ts_us`
      ));
    } catch (error) {
      container.appendChild(el("div", "details-empty", String(error)));
      return;
    }

    // counters from the frame's last submit_frame / render args
    let sa: Record<string, unknown> | null = null;
    let ra: Record<string, unknown> | null = null;
    const shapeMovies = new Map<string, { count: number; ms: number }>();
    let shapeCount = 0;
    let shapeMs = 0;
    let textures = 0;
    for (const row of rows) {
      const name = String(row["name"]);
      const argsRaw = row["args"];
      let args: Record<string, unknown> | null = null;
      if (typeof argsRaw === "string" && argsRaw) {
        try {
          args = JSON.parse(argsRaw) as Record<string, unknown>;
        } catch {
          /* skip */
        }
      }
      if (name === "submit_frame" && args) sa = args;
      else if (name === "render" && args) ra = args;
      else if (name === "register_shape") {
        shapeCount++;
        shapeMs += toNumber(row["dur_us"]) / 1000;
        const movie = String(args?.["movie"] ?? "?").split("?")[0].split("/").pop() ?? "?";
        const entry = shapeMovies.get(movie) ?? { count: 0, ms: 0 };
        entry.count++;
        entry.ms += toNumber(row["dur_us"]) / 1000;
        shapeMovies.set(movie, entry);
      } else if (name === "create_empty_texture") textures++;
    }

    if (!sa && !ra) {
      container.appendChild(
        el(
          "div",
          "details-empty",
          "В этом кадре нет тика с рендер-счётчиками (кадр без рендера или профиль записан без инструментированного Ruffle)."
        )
      );
    } else {
      const table = el("table", "grid") as HTMLTableElement;
      const head = table.createTHead().insertRow();
      head.appendChild(el("th", "", "Счётчик"));
      head.appendChild(el("th", "num", "Значение"));
      const body = table.createTBody();
      for (const counter of COUNTERS) {
        const source = counter.src === "sa" ? sa : ra;
        const value = source?.[counter.key];
        if (value === undefined) continue;
        const tr = body.insertRow();
        tr.insertCell().textContent = counter.label;
        const td = tr.insertCell();
        td.className = "num";
        td.textContent = toNumber(value).toLocaleString("ru");
      }
      container.appendChild(table);
    }

    if (shapeCount > 0) {
      container.appendChild(
        el("div", "panel-note", `Тесселяции в кадре: ${shapeCount} (${formatMs(shapeMs)}) — по SWF:`)
      );
      const table = el("table", "grid") as HTMLTableElement;
      const head = table.createTHead().insertRow();
      head.appendChild(el("th", "", "SWF"));
      head.appendChild(el("th", "num", "шейпов"));
      head.appendChild(el("th", "num", "мс"));
      const body = table.createTBody();
      for (const [movie, entry] of [...shapeMovies.entries()].sort((x, y) => y[1].count - x[1].count)) {
        const tr = body.insertRow();
        tr.insertCell().textContent = movie;
        const countCell = tr.insertCell();
        countCell.className = "num";
        countCell.textContent = String(entry.count);
        const msCell = tr.insertCell();
        msCell.className = "num";
        msCell.textContent = entry.ms.toFixed(1);
      }
      container.appendChild(table);
    }
    if (textures > 0) {
      container.appendChild(el("div", "panel-note dim", `Создано текстур в кадре: ${textures}`));
    }
    container.appendChild(
      el(
        "div",
        "dim panel-note",
        "Карты экрана (heat map / regions, как в Scout) нет: форк не записывает геометрию dirty-регионов."
      )
    );
  }
}
