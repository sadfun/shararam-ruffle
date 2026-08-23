// DuckDB-wasm bootstrap and profile loading.

import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

let db: duckdb.AsyncDuckDB | null = null;
let connection: duckdb.AsyncDuckDBConnection | null = null;

export async function initEngine(): Promise<void> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker }
  });
  const worker = new Worker(bundle.mainWorker!);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
}

/** Opens a profile file (read-only) as the current database. */
export async function openProfile(file: File): Promise<void> {
  if (!db) throw new Error("engine not ready");
  if (connection) {
    await connection.close();
    connection = null;
  }
  const name = "profile.duckdb";
  try {
    await db.dropFile(name);
  } catch {
    /* first open */
  }
  await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
  await db.open({
    path: name,
    accessMode: duckdb.DuckDBAccessMode.READ_ONLY
  });
  connection = await db.connect();
}

export interface Row {
  [key: string]: unknown;
}

/** Runs a query, returns plain JS rows (BigInt kept as BigInt). */
export async function query(sql: string): Promise<{ columns: string[]; rows: Row[] }> {
  if (!connection) throw new Error("no profile open");
  const table = await connection.query(sql);
  const columns = table.schema.fields.map(field => field.name);
  const rows: Row[] = table.toArray().map(row => row.toJSON() as Row);
  return { columns, rows };
}

export function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (value == null) return 0;
  return Number(value);
}
