// TEMPORARY diagnostic route — deleted as soon as the cause is known.
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const mode = new URL(req.url).searchParams.get("mode") ?? "info";
  const out: Record<string, unknown> = { mode };

  const time = async (label: string, fn: () => unknown) => {
    const t = Date.now();
    try {
      const value = await fn();
      out[label] = { ok: true, ms: Date.now() - t, value: JSON.parse(JSON.stringify(value ?? null)) };
    } catch (e) {
      out[label] = { ok: false, ms: Date.now() - t, error: String(e).slice(0, 400) };
    }
  };

  if (mode === "info") {
    out.cwd = process.cwd();
    out.workerExists = fs.existsSync(path.join(process.cwd(), "scripts", "pg-worker.mjs"));
    out.pgExists = fs.existsSync(path.join(process.cwd(), "node_modules", "pg", "package.json"));
    out.databaseUrlSet = Boolean(process.env.DATABASE_URL);
    return Response.json(out);
  }

  const db = await import("@/lib/db");

  if (mode === "read") {
    await time("read", () => db.get("select count(*) as c from plans"));
    await time("read2", () => db.get("select current_user as who"));
    return Response.json(out);
  }

  if (mode === "tx") {
    await time("tx", () => db.tx(() => db.get("select 1 as ok")));
    return Response.json(out);
  }

  if (mode === "write") {
    await time("write", () => db.run("update organizations set updated_at = updated_at where id = ?", ["__probe_none__"]));
    return Response.json(out);
  }

  if (mode === "password") {
    const pw = await import("@/lib/password");
    await time("hash", () => pw.hashPassword("probe-password-123"));
    await time("verify", async () => {
      const h = await pw.hashPassword("probe-password-123");
      return pw.verifyPassword("probe-password-123", h);
    });
    return Response.json(out);
  }

  if (mode === "login") {
    const { loginAction } = await import("@/lib/actions/auth");
    const form = new FormData();
    form.set("email", process.env.ADMIN_EMAIL ?? "");
    form.set("password", process.env.DIAG_PASSWORD ?? "");
    await time("login", () => loginAction({}, form));
    return Response.json(out);
  }

  out.error = "unknown mode";
  return Response.json(out);
}
