/**
 * Postgres worker.
 *
 * The application's data layer is synchronous (it was written on better-sqlite3),
 * but every Node Postgres client is asynchronous. This worker owns the real
 * connection and answers requests from the main thread, which blocks on a
 * SharedArrayBuffer with Atomics.wait. The result is therefore synchronous to
 * every caller while the actual I/O happens here.
 *
 * Configure with:
 *   DATABASE_URL=postgres://user:pass@host:5432/db   (required)
 *   BIZPILOT_PG_SCHEMA=1                             (apply sql/ on start)
 */
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { url } = workerData;
const HEADER_BYTES = 16;
const MAX_CHUNK = 4 * 1024 * 1024;

// --- type parsers: make Postgres results look like the SQLite results the app expects
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));      // int8 / count(*)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));    // numeric
pg.types.setTypeParser(21, (v) => (v === null ? null : Number(v)));      // int2
pg.types.setTypeParser(23, (v) => (v === null ? null : Number(v)));      // int4
pg.types.setTypeParser(700, (v) => (v === null ? null : Number(v)));     // float4
pg.types.setTypeParser(701, (v) => (v === null ? null : Number(v)));     // float8

/**
 * Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only, and serverless
 * platforms such as Vercel have no IPv6 egress — the connection dies with
 * ENOTFOUND and, without a connect timeout, the bridge waits its full 120s
 * before the request fails. Use the pooler host instead
 * (`aws-0-<region>.pooler.supabase.com`) and fail fast if it is wrong.
 */
const parsedUrl = (() => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
})();
const localHost = parsedUrl ? ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname) : false;

/**
 * TLS decision, made once and applied explicitly.
 *
 * `pg-connection-string` maps `sslmode=require` to `ssl: {}`, and Node then
 * verifies the chain — which a Supavisor/Cloud SQL style pooler cannot pass in
 * every region ("self-signed certificate in certificate chain"). libpq's own
 * `sslmode=require` means *encrypt, do not verify*, so this keeps the same
 * protection level instead of failing the connection. `verify-ca` and
 * `verify-full` are still honoured as written.
 */
const sslMode = parsedUrl ? parsedUrl.searchParams.get("sslmode") : null;
const wantsVerification = sslMode === "verify-ca" || sslMode === "verify-full";
const connectionString = (() => {
  if (!parsedUrl) return url;
  const clean = new URL(url);
  clean.searchParams.delete("sslmode");
  return clean.toString();
})();

const clientConfig = {
  connectionString,
  application_name: "bizpilot-app",
  connectionTimeoutMillis: 15000,
  // A serverless platform freezes the process between requests; the pooler then
  // drops the socket. Without these, the next query waits on a dead connection
  // until the bridge's 120s deadline instead of failing fast and reconnecting.
  query_timeout: 20000,
  statement_timeout: 20000,
  keepAlive: true,
  ...(localHost || wantsVerification ? {} : { ssl: { rejectUnauthorized: false } }),
};

/**
 * One connection, re-established on demand.
 *
 * The main thread only sees a synchronous call, so a connection that died while
 * the function was frozen must be detected and replaced *here*. Retries are
 * skipped inside a transaction: silently replaying statements after a reconnect
 * would break atomicity.
 */
let client = null;
let connected = false;
let inTransaction = false;

const RETRYABLE = /Connection terminated|not queryable|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|timeout|Client has already been connected|Connection closed/i;

async function connect() {
  const fresh = new pg.Client(clientConfig);
  fresh.on("error", () => {
    if (client === fresh) connected = false;
  });
  await fresh.connect();
  client = fresh;
  connected = true;
  return fresh;
}

async function ensureClient() {
  if (connected && client) return client;
  if (client) {
    try {
      await client.end();
    } catch {
      /* the connection is already gone; a new one is what matters */
    }
    client = null;
    connected = false;
  }
  return connect();
}

async function query(sql, params) {
  const run = async () => {
    const live = await ensureClient();
    return live.query(sql, params);
  };
  try {
    return await run();
  } catch (error) {
    if (inTransaction || !RETRYABLE.test(String(error?.message ?? error))) throw error;
    connected = false;
    return run();
  }
}

/** Postgres wants $1,$2…; the app writes ?. Never rewrites inside quoted text. */
function toPositional(sql) {
  let out = "";
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "?") {
      out += `$${++n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** SQLite LIKE is case-insensitive; Postgres LIKE is not. Preserve behaviour. */
function normalise(sql) {
  return sql.replace(/\snot\s+like\s/gi, " NOT ILIKE ").replace(/\slike\s/gi, " ILIKE ");
}

async function applySchema() {
  const dir = path.join(process.cwd(), "sql");
  for (const file of ["schema.sqlite.sql", "seed_plans.sql", "rls.postgres.sql"]) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await query(sql);
  }
}

async function handle(msg) {
  switch (msg.mode) {
    case "init": {
      try {
        await ensureClient();
      } catch (connectError) {
        const hint =
          parsedUrl && !localHost && !wantsVerification && /ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|self-signed certificate/.test(String(connectError))
            ? ` — cannot reach ${parsedUrl.hostname}. Supabase direct hosts are IPv6-only; use the pooler host (aws-0-<region>.pooler.supabase.com) in DATABASE_URL.`
            : "";
        throw new Error(`${String(connectError?.message ?? connectError)}${hint}`);
      }
      const { rows } = await query("select current_database() as db, current_user as who");
      if (msg.applySchema) await applySchema();
      return { ...rows[0], schema: Boolean(msg.applySchema) };
    }
    case "exec": {
      const head = String(msg.sql).trim().toLowerCase();
      await query(msg.sql);
      if (head === "begin" || head === "start transaction") inTransaction = true;
      if (head === "commit" || head === "rollback") inTransaction = false;
      return { ok: true };
    }
    case "all":
    case "get": {
      const res = await query(normalise(toPositional(msg.sql)), msg.params ?? []);
      return msg.mode === "get" ? res.rows[0] ?? null : res.rows;
    }
    case "run": {
      const res = await query(normalise(toPositional(msg.sql)), msg.params ?? []);
      return { changes: res.rowCount ?? 0, rows: res.rows };
    }
    case "one": {
      const res = await query(normalise(toPositional(msg.sql)), msg.params ?? []);
      return res.rows[0] ?? null;
    }
    default:
      throw new Error(`unknown mode ${msg.mode}`);
  }
}

function write(sab, payload, state) {
  const i32 = new Int32Array(sab, 0, 4);
  const body = new Uint8Array(sab, HEADER_BYTES);
  const bytes = Buffer.from(payload, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const slice = bytes.subarray(offset, offset + Math.min(MAX_CHUNK, body.length));
    body.set(slice, 0);
    Atomics.store(i32, 1, slice.length);
    Atomics.store(i32, 0, 1); // chunk ready
    Atomics.notify(i32, 0);
    Atomics.wait(i32, 2, 0, 120_000); // wait for the reader
    Atomics.store(i32, 2, 0);
    offset += slice.length;
  }
  Atomics.store(i32, 1, 0);
  Atomics.store(i32, 0, state); // 2 = done, 3 = error
  Atomics.notify(i32, 0);
}

parentPort.on("message", async (msg) => {
  const sab = msg.sab;
  try {
    const result = await handle(msg);
    write(sab, JSON.stringify({ ok: true, result }), 2);
  } catch (error) {
    write(sab, JSON.stringify({ ok: false, error: error?.message ?? String(error), code: error?.code }), 3);
  }
});

process.on("unhandledRejection", (e) => {
  console.error("[pg-worker] unhandled rejection", e);
});
