// TEMPORARY diagnostic route — deleted as soon as the cause is known.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { Worker } from "node:worker_threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = {};
  const url = process.env.DATABASE_URL ?? "";
  out.databaseUrlSet = Boolean(url);
  try {
    const u = new URL(url);
    out.host = u.hostname;
    out.port = u.port;
    out.sslmode = u.searchParams.get("sslmode");
    out.pooler = u.username;
  } catch (e) {
    out.urlParseError = String(e);
  }
  out.cwd = process.cwd();
  const workerPath = path.join(process.cwd(), "scripts", "pg-worker.mjs");
  out.workerPath = workerPath;
  out.workerExists = fs.existsSync(workerPath);
  out.pgExists = fs.existsSync(path.join(process.cwd(), "node_modules", "pg", "package.json"));

  // 0) raw TCP reachability of both host shapes from this runtime
  const tcp = (host: string, port: number) =>
    new Promise((resolve) => {
      const s = net.connect({ host, port });
      const finish = (v: unknown) => { s.destroy(); resolve(v); };
      s.setTimeout(6000, () => finish({ host, error: "timeout" }));
      s.on("connect", () => finish({ host, ok: true }));
      s.on("error", (e) => finish({ host, error: String(e).slice(0, 160) }));
    });
  out.tcp = {
    direct: await tcp("db.mpyuknincvfrfrvanpio.supabase.co", 5432),
    pooler: await tcp("aws-0-us-east-1.pooler.supabase.com", 5432),
  };

  // 1) direct async pg connect
  const t0 = Date.now();
  try {
    const pgMod = await import("pg");
    const Client = (pgMod as unknown as { default: { Client: new (c: unknown) => { connect(): Promise<void>; query(q: string): Promise<{ rows: unknown }>; end(): Promise<void> } } }).default.Client;
    for (const ssl of [false, { rejectUnauthorized: false }] as const) {
      const started = Date.now();
      try {
        const c = new Client({ connectionString: url, connectionTimeoutMillis: 7000, ssl: ssl || undefined });
        await c.connect();
        const r = await c.query("select 1 as ok");
        await c.end();
        out[`direct_ssl_${ssl ? "on" : "off"}`] = { rows: r.rows, ms: Date.now() - started };
      } catch (e) {
        out[`direct_ssl_${ssl ? "on" : "off"}`] = { error: String(e).slice(0, 300), ms: Date.now() - started };
      }
    }
  } catch (e) {
    out.directImportError = String(e).slice(0, 300);
  }
  out.directMs = Date.now() - t0;

  // 2) worker bridge, 8s cap
  out.worker = await new Promise((resolve) => {
    let settled = false;
    const done = (v: unknown) => { if (!settled) { settled = true; resolve(v); } };
    let w: Worker;
    try {
      w = new Worker(workerPath, { workerData: { url } });
    } catch (e) {
      return done({ spawnError: String(e).slice(0, 300) });
    }
    w.on("error", (e) => done({ error: String(e).slice(0, 400) }));
    w.on("exit", (code) => done({ exit: code }));
    w.on("message", (m) => done({ message: String(m).slice(0, 150) }));
    setTimeout(() => done({ timeout: true }), 8000);
  });

  return Response.json(out);
}
