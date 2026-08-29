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

// Counters carried by the instrumented build in the args of the last
// render/submit_frame of each animation frame.
const GPU_FEATURES: { key: string; label: string; src: "sa" | "ra" }[] = [
  { key: "commands", label: "команды", src: "sa" },
  { key: "shapes", label: "шейпы", src: "sa" },
  { key: "bitmaps", label: "битмапы", src: "sa" },
  { key: "rects", label: "прямоугольники", src: "sa" },
  { key: "stencil_masks", label: "stencil-маски", src: "sa" },
  { key: "alpha_masks", label: "alpha-маски", src: "sa" },
  { key: "blend_layer", label: "layer-бленды", src: "sa" },
  { key: "blend_complex", label: "сложные бленды", src: "sa" },
  { key: "blend_shader", label: "shader-бленды", src: "sa" },
  { key: "cache_commands", label: "cacheAsBitmap-команды", src: "sa" },
  { key: "display_objects", label: "display objects", src: "ra" },
  { key: "offscreen_renders", label: "оффскрин-рендеры", src: "ra" },
  { key: "layer_blends_inlined", label: "инлайн-бленды", src: "ra" },
  { key: "textures_updated", label: "обновления текстур", src: "ra" }
];

function frameIndexAt(model: ProfileModel, endMs: number): number {
  const times = model.frameTimesMs;
  let lo = 0;
  let hi = times.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < endMs - 0.5) lo = mid + 1;
    else {
      best = mid;
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The "why is the GPU busy" view: joins each frame's measured GPU-queue
 * latency (gpu/fence_wait) with the render-command mix of that frame, then
 * shows which counters separate heavy frames from light ones. This is the
 * workflow that found the filter problem, built in.
 */
export async function renderGpuTab(
  container: HTMLElement,
  model: ProfileModel,
  onFrame: (frameIndex: number) => void
) {
  container.textContent = "";
  const extracts = GPU_FEATURES.map(
    f => `CAST(regexp_extract(${f.src}, '"${f.key}":([0-9]+)', 1) AS INT) AS "${f.key}"`
  ).join(", ");
  let rows;
  try {
    ({ rows } = await query(
      `WITH fr AS (SELECT ts_us AS end_us, ts_us - CAST(dt_ms*1000 AS BIGINT) AS start_us, dt_ms
          FROM frames WHERE dt_ms BETWEEN 5 AND 500),
        g AS (SELECT f.end_us, f.dt_ms, max(e.dur_us)/1000.0 AS gpu_ms FROM fr f
          JOIN events e ON e.cat = 'gpu' AND e.ts_us >= f.start_us AND e.ts_us < f.end_us
          GROUP BY 1, 2),
        s AS (SELECT f.end_us,
          (SELECT e.args FROM events e WHERE e.name = 'submit_frame'
             AND e.ts_us >= f.start_us AND e.ts_us < f.end_us ORDER BY e.ts_us DESC LIMIT 1) AS sa,
          (SELECT e.args FROM events e WHERE e.cat = 'render' AND e.name = 'render'
             AND e.ts_us >= f.start_us AND e.ts_us < f.end_us ORDER BY e.ts_us DESC LIMIT 1) AS ra
          FROM fr f)
        SELECT g.end_us, g.dt_ms, g.gpu_ms, ${extracts}
        FROM g JOIN s USING (end_us) WHERE s.sa IS NOT NULL AND s.ra IS NOT NULL
        ORDER BY g.end_us`
    ));
  } catch (error) {
    container.appendChild(el("div", "details-empty", String(error)));
    return;
  }
  if (!rows.length) {
    container.appendChild(
      el(
        "div",
        "details-empty",
        "Нет данных gpu/fence_wait — профиль записан сборкой без GPU-датчика."
      )
    );
    return;
  }

  const gpu = rows.map(row => toNumber(row["gpu_ms"]));
  const sorted = [...gpu].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const buckets = (value: number) => (value <= 20 ? 0 : value <= 40 ? 1 : 2);
  const bucketNames = ["≤20 мс", "20–40 мс", ">40 мс"];
  const bucketCounts = [0, 0, 0];
  for (const value of gpu) bucketCounts[buckets(value)]++;

  container.appendChild(
    el(
      "div",
      "frame-summary",
      `кадров с GPU-меткой: ${rows.length} · медиана ожидания GPU ${formatMs(median)} · ` +
        bucketNames.map((name, i) => `${name}: ${bucketCounts[i]}`).join(" · ")
    )
  );

  // Per counter: averages inside each latency bucket + correlation with the
  // latency itself. Latency includes queue backlog, so the mix comparison
  // (what heavy frames contain more of) matters more than absolute ms.
  const meanGpu = gpu.reduce((a, b) => a + b, 0) / gpu.length;
  const statRows = GPU_FEATURES.map(feature => {
    const values = rows.map(row => toNumber(row[feature.key]));
    const bucketSum = [0, 0, 0];
    for (let i = 0; i < values.length; i++) bucketSum[buckets(gpu[i])] += values[i];
    const avg = bucketSum.map((sum, i) => (bucketCounts[i] ? sum / bucketCounts[i] : 0));
    const meanValue = values.reduce((a, b) => a + b, 0) / values.length;
    let cov = 0;
    let varG = 0;
    let varV = 0;
    for (let i = 0; i < values.length; i++) {
      const dg = gpu[i] - meanGpu;
      const dv = values[i] - meanValue;
      cov += dg * dv;
      varG += dg * dg;
      varV += dv * dv;
    }
    const corr = varG > 0 && varV > 0 ? cov / Math.sqrt(varG * varV) : 0;
    const ratio = avg[0] > 0.05 ? avg[2] / avg[0] : avg[2] > 0.05 ? Infinity : NaN;
    return { feature, avg, corr, ratio };
  }).filter(stat => stat.avg.some(value => value > 0.01));
  statRows.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));

  renderTable(
    container,
    ["счётчик", "корр. с GPU", ...bucketNames.map(name => `сред. при ${name}`), "тяж./лёгк."],
    statRows.map(stat => [
      stat.feature.label,
      stat.corr.toFixed(2),
      ...stat.avg.map(value => (value >= 100 ? String(Math.round(value)) : value.toFixed(1))),
      Number.isNaN(stat.ratio) ? "·" : stat.ratio === Infinity ? "∞" : `×${stat.ratio.toFixed(1)}`
    ])
  );
  container.appendChild(
    el(
      "div",
      "dim",
      "Латентность fence включает накопленную очередь: смотрите, чего в тяжёлых кадрах больше, а не абсолютные мс."
    )
  );

  const heavy = rows
    .map((row, i) => ({ row, gpuMs: gpu[i] }))
    .sort((a, b) => b.gpuMs - a.gpuMs)
    .slice(0, 30);
  container.appendChild(el("div", "frame-summary", "Самые тяжёлые для GPU кадры:"));
  const heavyBody = el("div");
  renderTable(
    heavyBody,
    ["t", "GPU", "кадр", "команды", "шейпы", "сложные бленды", "cacheAsBitmap", "оффскрин"],
    heavy.map(({ row, gpuMs }) => [
      formatClock((toNumber(row["end_us"]) - model.t0Us) / 1000),
      formatMs(gpuMs),
      formatMs(toNumber(row["dt_ms"])),
      String(toNumber(row["commands"])),
      String(toNumber(row["shapes"])),
      String(toNumber(row["blend_complex"])),
      String(toNumber(row["cache_commands"])),
      String(toNumber(row["offscreen_renders"]))
    ]),
    rowIndex => {
      const index = frameIndexAt(model, (toNumber(heavy[rowIndex].row["end_us"]) - model.t0Us) / 1000);
      if (index >= 0) onFrame(index);
    }
  );
  container.appendChild(heavyBody);
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
