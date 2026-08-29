// Bottom-panel tables: RTMP RPC, loads, slow events, free SQL.
// Args are parsed in JS so nothing depends on optional DuckDB extensions.

import { query, toNumber, Row } from "./db";
import { ProfileModel, formatMs, formatBytes, formatClock } from "./model";
import { severityColor } from "./frames";

export interface EventRef {
  seq: number;
  tsMs: number;
}

type SelectHandler = (seq: number) => void;

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderTable(
  container: HTMLElement,
  headers: string[],
  rows: (string | HTMLElement)[][],
  onRowClick?: (rowIndex: number) => void
) {
  container.textContent = "";
  const table = el("table", "grid") as HTMLTableElement;
  const head = table.createTHead().insertRow();
  for (const header of headers) head.appendChild(el("th", "", header));
  const body = table.createTBody();
  rows.forEach((cells, rowIndex) => {
    const tr = body.insertRow();
    for (const cell of cells) {
      const td = tr.insertCell();
      if (typeof cell === "string") td.textContent = cell;
      else td.appendChild(cell);
    }
    if (onRowClick) {
      tr.classList.add("clickable");
      tr.addEventListener("click", () => onRowClick(rowIndex));
    }
  });
  container.appendChild(table);
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function preview(value: unknown, max = 140): string {
  // duckdb-wasm returns BIGINT columns as BigInt, which JSON.stringify rejects.
  const text =
    typeof value === "string"
      ? value
      : typeof value === "bigint"
        ? value.toString()
        : JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function renderRtmpTab(
  container: HTMLElement,
  t0Us: number,
  onSelect: SelectHandler
) {
  const { rows } = await query(
    "SELECT seq, ts_us, name, args FROM events WHERE source = 'ruffle' AND cat = 'rtmp' AND name IN ('send','recv') ORDER BY ts_us"
  );
  if (!rows.length) {
    container.textContent = "";
    container.appendChild(el("div", "details-empty", "RTMP-команд в этом профиле нет."));
    return;
  }
  interface Call {
    row: Row;
    args: Record<string, unknown>;
    replyMs?: number;
    replyKind?: string;
  }
  const calls: Call[] = rows.map(row => ({ row, args: parseArgs(row["args"]) }));
  // match replies (recv result/error) to calls by transaction id
  const pendingByTid = new Map<number, Call>();
  for (const call of calls) {
    const tid = toNumber(call.args["tid"]);
    const direction = String(call.row["name"]);
    const kind = String(call.args["kind"] ?? "");
    if (direction === "send" && (kind === "call" || kind === "connect")) {
      pendingByTid.set(tid, call);
    } else if (direction === "recv" && (kind === "result" || kind === "error" || kind === "connect_result")) {
      const origin = pendingByTid.get(tid);
      if (origin) {
        origin.replyMs = (toNumber(call.row["ts_us"]) - toNumber(origin.row["ts_us"])) / 1000;
        origin.replyKind = kind;
        pendingByTid.delete(tid);
      }
    }
  }
  const tableRows = calls.map(call => {
    const direction = String(call.row["name"]);
    const kind = String(call.args["kind"] ?? "");
    const dirCell = el(
      "span",
      `pill ${direction === "send" ? "pill-send" : "pill-recv"}`,
      direction === "send" ? "→" : "←"
    );
    const latency =
      call.replyMs !== undefined
        ? `${formatMs(call.replyMs)}${call.replyKind === "error" ? " ⚠" : ""}`
        : "";
    return [
      formatClock((toNumber(call.row["ts_us"]) - t0Us) / 1000),
      dirCell,
      String(call.args["method"] ?? ""),
      kind,
      String(call.args["tid"] ?? ""),
      latency,
      preview(call.args["args"])
    ];
  });
  renderTable(
    container,
    ["t", "", "метод", "тип", "tid", "ответ через", "аргументы"],
    tableRows,
    rowIndex => onSelect(toNumber(calls[rowIndex].row["seq"]))
  );
}

export async function renderLoadsTab(
  container: HTMLElement,
  t0Us: number,
  onSelect: SelectHandler
) {
  const { rows } = await query(
    "SELECT seq, ts_us, dur_us, source, name, args FROM events WHERE (cat = 'load' AND name IN ('movie_load_start','movie_data','movie_complete','movie_error','root_movie')) OR (cat = 'http' AND name IN ('fetch', 'resource', 'proxy')) ORDER BY ts_us"
  );
  interface LoadRow {
    row: Row;
    args: Record<string, unknown>;
  }
  const items: LoadRow[] = rows.map(row => ({ row, args: parseArgs(row["args"]) }));
  // Sequential movie loads are the "characters load one by one" story:
  // show start → complete latency per loader id.
  const startByLoader = new Map<number, number>();
  const tableRows: (string | HTMLElement)[][] = [];
  const refs: number[] = [];
  for (const item of items) {
    const name = String(item.row["name"]);
    const tsMs = (toNumber(item.row["ts_us"]) - t0Us) / 1000;
    const durMs = toNumber(item.row["dur_us"]) / 1000;
    const loader = toNumber(item.args["loader"]);
    let extra = "";
    if (name === "movie_load_start") startByLoader.set(loader, tsMs);
    if (name === "movie_complete" && startByLoader.has(loader)) {
      extra = `всего ${formatMs(tsMs + durMs - startByLoader.get(loader)!)}`;
    }
    const url = String(item.args["url"] ?? item.args["path"] ?? "");
    const bytes = toNumber(item.args["bytes"] ?? item.args["transfer"] ?? 0);
    tableRows.push([
      formatClock(tsMs),
      `${item.row["source"]}`,
      name,
      url.length > 80 ? `…${url.slice(-79)}` : url,
      bytes ? formatBytes(bytes) : "",
      durMs > 0 ? formatMs(durMs) : "",
      extra || (item.args["status"] !== undefined ? `HTTP ${item.args["status"]}` : "")
    ]);
    refs.push(toNumber(item.row["seq"]));
  }
  if (!tableRows.length) {
    container.textContent = "";
    container.appendChild(el("div", "details-empty", "Загрузок в этом профиле нет."));
    return;
  }
  renderTable(
    container,
    ["t", "источник", "событие", "url", "байты", "длит.", ""],
    tableRows,
    rowIndex => onSelect(refs[rowIndex])
  );
}

export async function renderSlowTab(
  container: HTMLElement,
  t0Us: number,
  onSelect: SelectHandler
) {
  const { rows } = await query(
    "SELECT seq, ts_us, dur_us, source, cat, name, args FROM events WHERE dur_us >= 8000 ORDER BY dur_us DESC LIMIT 300"
  );
  if (!rows.length) {
    container.textContent = "";
    container.appendChild(
      el("div", "details-empty", "Событий длиннее 8 мс нет — ровная сессия.")
    );
    return;
  }
  const refs = rows.map(row => toNumber(row["seq"]));
  renderTable(
    container,
    ["длит.", "t", "источник", "категория", "событие", "аргументы"],
    rows.map(row => [
      formatMs(toNumber(row["dur_us"]) / 1000),
      formatClock((toNumber(row["ts_us"]) - t0Us) / 1000),
      String(row["source"]),
      String(row["cat"]),
      String(row["name"]),
      preview(row["args"] ?? "")
    ]),
    rowIndex => onSelect(refs[rowIndex])
  );
}

/** Top slowest animation frames; a click jumps the timeline to the frame. */
export function renderFramesTab(
  container: HTMLElement,
  model: ProfileModel,
  onFrame: (frameIndex: number) => void
) {
  const GAP_MS = 500;
  const order: number[] = [];
  for (let i = 0; i < model.frameDtMs.length; i++) {
    if (model.frameDtMs[i] > 20 && model.frameDtMs[i] <= GAP_MS) order.push(i);
  }
  order.sort((a, b) => model.frameDtMs[b] - model.frameDtMs[a]);
  const top = order.slice(0, 300);
  if (!top.length) {
    container.textContent = "";
    container.appendChild(el("div", "details-empty", "Кадров дольше 20 мс нет — ровная сессия."));
    return;
  }
  renderTable(
    container,
    ["длит.", "t", "экв. fps", ""],
    top.map(index => {
      const dt = model.frameDtMs[index];
      const chip = el("span", "sev-chip");
      chip.style.background = severityColor(dt);
      const dur = el("span", "", ` ${formatMs(dt)}`);
      const cell = el("span");
      cell.appendChild(chip);
      cell.appendChild(dur);
      return [
        cell,
        formatClock(model.frameTimesMs[index] - dt),
        (1000 / dt).toFixed(1),
        ""
      ];
    }),
    rowIndex => onFrame(top[rowIndex])
  );
}

/**
 * What happened inside one frame: events overlapping its window, longest
 * first, plus a per-category time summary. Instrumented Ruffle builds put
 * the render command stats into the tick event's args — they show up here.
 */
export async function renderFrameDetails(
  container: HTMLElement,
  model: ProfileModel,
  frameIndex: number,
  onSelectEvent: SelectHandler,
  onZoom: () => void
) {
  const endMs = model.frameTimesMs[frameIndex];
  const dtMs = model.frameDtMs[frameIndex];
  const startUs = Math.round(model.t0Us + (endMs - dtMs) * 1000);
  const endUs = Math.round(model.t0Us + endMs * 1000);
  // Session-long spans (tunnel connections and the like) overlap every
  // frame without being frame-local work — the 5s cap keeps them out.
  const { rows } = await query(
    `SELECT seq, ts_us, dur_us, source, cat, name, args FROM events
     WHERE ts_us < ${endUs} AND ts_us + dur_us > ${startUs} AND dur_us < 5000000
     ORDER BY dur_us DESC LIMIT 240`
  );

  container.textContent = "";
  const header = el("div", "details-header");
  const chip = el("span", "sev-chip");
  chip.style.background = severityColor(dtMs);
  header.appendChild(chip);
  header.appendChild(el("span", "details-name", ` Кадр @${formatClock(endMs - dtMs)}`));
  header.appendChild(el("span", "details-dur", ` · ${formatMs(dtMs)}`));
  header.appendChild(el("span", "dim", ` · ${(1000 / dtMs).toFixed(1)} fps экв.`));
  const zoom = el("button", "mini-button", "приблизить");
  zoom.addEventListener("click", onZoom);
  header.appendChild(zoom);
  container.appendChild(header);

  // per-category time, clipped to the frame window
  const byCat = new Map<string, number>();
  for (const row of rows) {
    const from = Math.max(toNumber(row["ts_us"]), startUs);
    const to = Math.min(toNumber(row["ts_us"]) + toNumber(row["dur_us"]), endUs);
    if (to <= from) continue;
    const cat = `${row["source"]}/${row["cat"]}`;
    byCat.set(cat, (byCat.get(cat) ?? 0) + (to - from) / 1000);
  }
  if (byCat.size) {
    const summary = el("div", "frame-summary");
    [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([cat, ms]) => {
        summary.appendChild(el("span", "frame-summary-item", `${cat} ${formatMs(ms)}`));
      });
    // How much of the frame nothing recorded explains. Server spans and async
    // network spans overlap the window without delaying the frame, so only
    // wasm work, page-side blocking events and GPU-queue waits count.
    const mainThread = rows
      .filter(
        row =>
          row["source"] === "ruffle" ||
          (row["source"] === "browser" &&
            (row["cat"] === "browser" || row["cat"] === "rec" || row["cat"] === "gpu") &&
            toNumber(row["dur_us"]) > 0)
      )
      .map(row => ({
        from: Math.max(toNumber(row["ts_us"]), startUs),
        to: Math.min(toNumber(row["ts_us"]) + toNumber(row["dur_us"]), endUs)
      }))
      .filter(span => span.to > span.from)
      .sort((a, b) => a.from - b.from);
    let coveredUs = 0;
    let reachUs = startUs;
    for (const span of mainThread) {
      if (span.to > reachUs) {
        coveredUs += span.to - Math.max(span.from, reachUs);
        reachUs = span.to;
      }
    }
    const unknownMs = dtMs - coveredUs / 1000;
    if (unknownMs > Math.max(2, dtMs * 0.15)) {
      const unknown = el("span", "frame-summary-item dim", `не учтено ${formatMs(unknownMs)}`);
      unknown.title =
        "Время кадра, не покрытое ничем записанным: работой wasm, блокировками " +
        "главного потока (stall, от ~30 мс) и ожиданием GPU (gpu/fence_wait). " +
        "Остаток — композитор браузера или неинструментированный JS.";
      summary.appendChild(unknown);
    }
    container.appendChild(summary);
  }

  if (!rows.length) {
    container.appendChild(el("div", "details-empty", "Внутри кадра не записано ни одного события."));
    return;
  }
  const listed = rows.slice(0, 80);
  const refs = listed.map(row => toNumber(row["seq"]));
  const body = el("div");
  renderTable(
    body,
    ["длит.", "t", "источник", "категория", "событие", "аргументы"],
    listed.map(row => [
      toNumber(row["dur_us"]) > 0 ? formatMs(toNumber(row["dur_us"]) / 1000) : "·",
      formatClock((toNumber(row["ts_us"]) - model.t0Us) / 1000),
      String(row["source"]),
      String(row["cat"]),
      String(row["name"]),
      preview(row["args"] ?? "")
    ]),
    rowIndex => onSelectEvent(refs[rowIndex])
  );
  container.appendChild(body);
}

export async function runSql(container: HTMLElement, sql: string) {
  container.textContent = "";
  try {
    const { columns, rows } = await query(sql);
    const limited = rows.slice(0, 500);
    renderTable(
      container,
      columns,
      limited.map(row => columns.map(column => preview(row[column], 200)))
    );
    if (rows.length > limited.length) {
      container.appendChild(
        el("div", "dim", `показаны первые ${limited.length} из ${rows.length} строк`)
      );
    }
  } catch (error) {
    container.appendChild(el("div", "sql-error", String(error)));
  }
}

export async function renderDetails(container: HTMLElement, seq: number, t0Us: number) {
  const { rows } = await query(`SELECT * FROM events WHERE seq = ${Math.floor(seq)}`);
  container.textContent = "";
  if (!rows.length) return;
  const row = rows[0];
  const tsMs = (toNumber(row["ts_us"]) - t0Us) / 1000;
  const durMs = toNumber(row["dur_us"]) / 1000;
  const header = el("div", "details-header");
  header.appendChild(el("span", "details-name", `${row["cat"]}/${row["name"]}`));
  header.appendChild(el("span", "dim", ` · ${row["source"]} · @${formatClock(tsMs)}`));
  if (durMs > 0) header.appendChild(el("span", "details-dur", ` · ${formatMs(durMs)}`));
  container.appendChild(header);
  const args = parseArgs(row["args"]);
  const pre = el("pre", "details-json");
  pre.textContent = Object.keys(args).length ? JSON.stringify(args, null, 2) : "(без аргументов)";
  container.appendChild(pre);
}
