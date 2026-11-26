import { Worker } from "node:worker_threads";
import path from "node:path";

/**
 * A synchronous Postgres client.
 *
 * The data layer (`all/get/run/tx`) is synchronous because it grew on
 * better-sqlite3, and 300+ call sites depend on that. `pg` is asynchronous, so a
 * worker thread owns the real connection and the main thread blocks on a
 * SharedArrayBuffer via `Atomics.wait` until the row set is back. Callers see the
 * same synchronous API; only the I/O moved.
 *
 * Trade-off, stated plainly: a query blocks this Node process for its duration,
 * exactly as better-sqlite3 already did. At SMB request volume that is invisible;
 * for high concurrency, move the hot paths to async queries.
 */

const HEADER_BYTES = 16;
const BUFFER_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export type PgResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: string };

type GlobalCache = { __bizpilotPg?: PgBridge };
const g = globalThis as unknown as GlobalCache;

/**
 * A `?`-placeholder count that disagrees with the parameter count is the single
 * most common way a hand-written statement breaks — and Postgres reports it as an
 * opaque protocol error. Failing early with both numbers makes it a five-second
 * fix instead of an hour.
 */
function assertPlaceholders(sql: string, params: unknown[]): void {
  let count = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "?") count += 1;
  }
  if (count !== params.length) {
    const head = sql.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(
      `SQL placeholder mismatch: ${count} placeholder(s) but ${params.length} parameter(s) — ${head}…`
    );
  }
}

export class PgBridge {
  private worker: Worker;
  private ready = false;

  constructor(url: string) {
    const workerPath =
      process.env.BIZPILOT_PG_WORKER ?? path.join(process.cwd(), "scripts", "pg-worker.mjs");
    this.worker = new Worker(workerPath, {
      workerData: { url },
      // Keep the process alive only while work is in flight.
      stdout: false,
      stderr: false,
    });
    this.worker.unref();
    this.worker.on("error", (e) => console.error("[pg-sync] worker error:", e));
  }

  /** Blocks the calling thread until the worker answers. */
  private call(payload: Record<string, unknown>): PgResult {
    const sab = new SharedArrayBuffer(HEADER_BYTES + BUFFER_BYTES);
    const i32 = new Int32Array(sab, 0, 4);
    const body = new Uint8Array(sab, HEADER_BYTES);
    Atomics.store(i32, 0, 0);

    this.worker.postMessage({ ...payload, sab });

    const chunks: Buffer[] = [];
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Postgres query timed out after ${TIMEOUT_MS / 1000}s`);
      const seen = Atomics.load(i32, 0);
      if (seen === 0) {
        Atomics.wait(i32, 0, 0, Math.min(left, 1_000));
        continue;
      }
      const state = Atomics.load(i32, 0);
      const len = Atomics.load(i32, 1);
      if (len > 0) chunks.push(Buffer.from(body.subarray(0, len)));
      // acknowledge so the worker may reuse the buffer
      Atomics.store(i32, 0, 0);
      Atomics.store(i32, 2, 1);
      Atomics.notify(i32, 2);
      if (state === 2 || state === 3) break;
    }

    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text) as PgResult;
    } catch {
      throw new Error(`Postgres worker returned unreadable payload: ${text.slice(0, 200)}`);
    }
  }

  private ensureReady() {
    if (this.ready) return;
    const res = this.call({ mode: "init", applySchema: process.env.BIZPILOT_PG_SCHEMA === "1" });
    if (!res.ok) throw new Error(`Could not connect to Postgres: ${res.error}`);
    const info = res.result as { db: string; who: string; schema: boolean };
    // eslint-disable-next-line no-console -- one line at boot so operators can see the engine
    console.info(
      `[db] engine=postgres database=${info.db} user=${info.who}${info.schema ? " (schema applied)" : ""}`
    );
    this.ready = true;
  }

  private unwrap<T>(res: PgResult): T {
    if (!res.ok) {
      const err = new Error(res.error) as Error & { code?: string };
      err.code = res.code;
      throw err;
    }
    return res.result as T;
  }

  all<T>(sql: string, params: unknown[]): T[] {
    assertPlaceholders(sql, params);
    this.ensureReady();
    return this.unwrap<T[]>(this.call({ mode: "all", sql, params }));
  }

  get<T>(sql: string, params: unknown[]): T | undefined {
    assertPlaceholders(sql, params);
    this.ensureReady();
    const row = this.unwrap<T | null>(this.call({ mode: "get", sql, params }));
    return row === null ? undefined : row;
  }

  run(sql: string, params: unknown[]): { changes: number; lastInsertRowid: number } {
    assertPlaceholders(sql, params);
    this.ensureReady();
    const res = this.unwrap<{ changes: number }>(this.call({ mode: "run", sql, params }));
    return { changes: res.changes ?? 0, lastInsertRowid: 0 };
  }

  exec(sql: string): void {
    this.ensureReady();
    this.unwrap(this.call({ mode: "exec", sql }));
  }

  one<T>(sql: string, params: unknown[]): T | null {
    assertPlaceholders(sql, params);
    this.ensureReady();
    return this.unwrap<T | null>(this.call({ mode: "one", sql, params }));
  }

  transaction<T>(fn: () => T): T {
    this.exec("begin");
    try {
      const value = fn();
      this.exec("commit");
      return value;
    } catch (e) {
      try {
        this.exec("rollback");
      } catch {
        /* the original error is the useful one */
      }
      throw e;
    }
  }
}

export function pgBridge(): PgBridge {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; cannot use the Postgres engine.");
  if (!g.__bizpilotPg) g.__bizpilotPg = new PgBridge(url);
  return g.__bizpilotPg;
}

export function isPostgresEngine(): boolean {
  return Boolean(process.env.DATABASE_URL) || process.env.BIZPILOT_ENGINE === "postgres";
}
