// Bottom-panel tables: RTMP RPC, loads, free SQL.
// Args are parsed in JS so nothing depends on optional DuckDB extensions.

import { query, toNumber, Row } from "./db";
import { formatMs, formatBytes, formatClock } from "./model";

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
    "SELECT seq, ts_us, dur_us, source, name, args FROM events WHERE (cat = 'load' AND name IN ('movie_load_start','movie_data','movie_cache_hit','movie_complete','movie_error','root_movie')) OR (cat = 'http' AND name IN ('fetch', 'resource', 'proxy')) ORDER BY ts_us"
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
