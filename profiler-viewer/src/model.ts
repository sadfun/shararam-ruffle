// Loads a profile into compact typed arrays for canvas rendering.

import { query, toNumber } from "./db";

export interface Kind {
  id: number;
  source: string;
  cat: string;
  name: string;
  lane: number;
  color: string;
}

export interface Lane {
  label: string;
  color: string;
  /** number of stacked sub-rows used by overlapping spans */
  depth: number;
}

export interface ProfileModel {
  /** epoch µs of the session start (t=0 on every chart) */
  t0Us: number;
  /** total duration in ms */
  durationMs: number;
  /** events sorted by start time, parallel arrays */
  count: number;
  seq: Float64Array;
  startMs: Float64Array;
  durMs: Float64Array;
  kindIds: Uint16Array;
  subRow: Uint8Array;
  kinds: Kind[];
  lanes: Lane[];
  /** browser animation frames */
  frameTimesMs: Float64Array;
  frameDtMs: Float64Array;
  meta: Map<string, string>;
  samples: { name: string; timesMs: Float64Array; values: Float64Array }[];
  /** screen recording (?rec=): timestamps of stored JPEG frames */
  snapTimesMs: Float64Array;
  snapTsUs: Float64Array;
}

// Category → lane grouping and palette (dark-surface steps of the reference
// categorical palette; lanes are labeled, color reinforces the group).
const LANES: { label: string; cats: string[]; color: string }[] = [
  { label: "frame", cats: ["frame"], color: "#3987e5" },
  { label: "script", cats: ["script", "input"], color: "#c98500" },
  { label: "gc", cats: ["gc"], color: "#9085e9" },
  { label: "render", cats: ["render", "text"], color: "#d95926" },
  { label: "load", cats: ["load", "swf", "asset"], color: "#199e70" },
  { label: "http", cats: ["http"], color: "#008300" },
  { label: "rtmp", cats: ["rtmp", "net", "socket"], color: "#d55181" },
  { label: "misc", cats: ["external", "marker", "browser", "server", "profiler"], color: "#8a8a80" }
];

function laneFor(cat: string): number {
  const index = LANES.findIndex(lane => lane.cats.includes(cat));
  return index >= 0 ? index : LANES.length - 1;
}

export async function loadProfile(): Promise<ProfileModel> {
  const metaRows = await query("SELECT key, value FROM meta");
  const meta = new Map<string, string>();
  for (const row of metaRows.rows) meta.set(String(row["key"]), String(row["value"]));

  const kindRows = await query(
    "SELECT DISTINCT source, cat, name FROM events ORDER BY source, cat, name"
  );
  const kinds: Kind[] = kindRows.rows.map((row, index) => {
    const cat = String(row["cat"]);
    const lane = laneFor(cat);
    return {
      id: index,
      source: String(row["source"]),
      cat,
      name: String(row["name"]),
      lane,
      color: LANES[lane].color
    };
  });
  const kindIndex = new Map<string, number>();
  kinds.forEach(kind => kindIndex.set(`${kind.source}|${kind.cat}|${kind.name}`, kind.id));

  const bounds = await query(
    `SELECT
       least(coalesce((SELECT min(ts_us) FROM events), 9e18),
             coalesce((SELECT min(ts_us) FROM frames), 9e18)) AS t0,
       greatest(coalesce((SELECT max(ts_us + dur_us) FROM events), 0),
                coalesce((SELECT max(ts_us) FROM frames), 0)) AS t1`
  );
  const t0Us = toNumber(bounds.rows[0]["t0"]);
  const t1Us = toNumber(bounds.rows[0]["t1"]);

  const events = await query(
    "SELECT seq, ts_us, dur_us, source, cat, name FROM events ORDER BY ts_us"
  );
  const count = events.rows.length;
  const seq = new Float64Array(count);
  const startMs = new Float64Array(count);
  const durMs = new Float64Array(count);
  const kindIds = new Uint16Array(count);
  events.rows.forEach((row, i) => {
    seq[i] = toNumber(row["seq"]);
    startMs[i] = (toNumber(row["ts_us"]) - t0Us) / 1000;
    durMs[i] = toNumber(row["dur_us"]) / 1000;
    kindIds[i] =
      kindIndex.get(`${row["source"]}|${row["cat"]}|${row["name"]}`) ?? 0;
  });

  // Stack overlapping spans per lane into sub-rows.
  const lanes: Lane[] = LANES.map(lane => ({ label: lane.label, color: lane.color, depth: 1 }));
  const subRow = new Uint8Array(count);
  const MAX_DEPTH = 6;
  const activeEnds: number[][] = LANES.map(() => []);
  for (let i = 0; i < count; i++) {
    const lane = kinds[kindIds[i]].lane;
    const ends = activeEnds[lane];
    const start = startMs[i];
    const end = start + Math.max(durMs[i], 0.001);
    let row = 0;
    while (row < ends.length && ends[row] > start + 0.0005) row++;
    if (row >= MAX_DEPTH) row = MAX_DEPTH - 1;
    ends[row] = Math.max(ends[row] ?? 0, end);
    subRow[i] = row;
    if (row + 1 > lanes[lane].depth) lanes[lane].depth = row + 1;
  }

  const frames = await query("SELECT ts_us, dt_ms FROM frames ORDER BY ts_us");
  const frameTimesMs = new Float64Array(frames.rows.length);
  const frameDtMs = new Float64Array(frames.rows.length);
  frames.rows.forEach((row, i) => {
    frameTimesMs[i] = (toNumber(row["ts_us"]) - t0Us) / 1000;
    frameDtMs[i] = toNumber(row["dt_ms"]);
  });

  // Screen recording index (the table exists only in newer profiles).
  let snapTimesMs = new Float64Array(0);
  let snapTsUs = new Float64Array(0);
  try {
    const snaps = await query("SELECT ts_us FROM snapshots ORDER BY ts_us");
    snapTimesMs = new Float64Array(snaps.rows.length);
    snapTsUs = new Float64Array(snaps.rows.length);
    snaps.rows.forEach((row, i) => {
      snapTsUs[i] = toNumber(row["ts_us"]);
      snapTimesMs[i] = (snapTsUs[i] - t0Us) / 1000;
    });
  } catch {
    /* profile recorded before screen recording existed */
  }

  const sampleRows = await query("SELECT ts_us, name, value FROM samples ORDER BY name, ts_us");
  const byName = new Map<string, { t: number[]; v: number[] }>();
  for (const row of sampleRows.rows) {
    const name = String(row["name"]);
    let series = byName.get(name);
    if (!series) byName.set(name, (series = { t: [], v: [] }));
    series.t.push((toNumber(row["ts_us"]) - t0Us) / 1000);
    series.v.push(toNumber(row["value"]));
  }
  const samples = [...byName.entries()].map(([name, series]) => ({
    name,
    timesMs: Float64Array.from(series.t),
    values: Float64Array.from(series.v)
  }));

  return {
    t0Us,
    durationMs: Math.max((t1Us - t0Us) / 1000, 1),
    count,
    seq,
    startMs,
    durMs,
    kindIds,
    subRow,
    kinds,
    lanes,
    frameTimesMs,
    frameDtMs,
    meta,
    samples,
    snapTimesMs,
    snapTsUs
  };
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatClock(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
