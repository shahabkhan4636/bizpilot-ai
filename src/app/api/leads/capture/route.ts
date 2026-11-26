import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { checkLeadLimit, recordUsage } from "@/lib/plans";
import { rateLimit } from "@/lib/ratelimit";
import { logActivity, audit } from "@/lib/audit";
import { dispatchTrigger } from "@/lib/automations";

/**
 * Public lead capture endpoint.
 *
 * Two ways to address a workspace:
 *   - header `x-org-slug: <workspace slug>` plus the shared key, or
 *   - JSON body field `org` with the slug.
 *
 * A shared key is required (env `LEAD_CAPTURE_KEY`); without it the endpoint is
 * closed rather than open to spam. Rate limited per IP. Respects the plan's lead
 * limit and fires the `lead.created` automation trigger.
 */
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-capture-key, x-org-slug",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

export async function POST(request: Request) {
  const configuredKey = (process.env.LEAD_CAPTURE_KEY ?? "").trim();
  if (!configuredKey) {
    return NextResponse.json(
      { ok: false, error: "Lead capture is not enabled on this deployment (LEAD_CAPTURE_KEY is not set)." },
      { status: 503, headers: cors() }
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limited = rateLimit(`capture:${ip}`, 20, 60);
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, error: `Too many submissions. Retry in ${limited.resetInSeconds}s.` },
      { status: 429, headers: cors() }
    );
  }

  const providedKey = request.headers.get("x-capture-key") ?? "";
  if (providedKey !== configuredKey) {
    return NextResponse.json({ ok: false, error: "Invalid capture key." }, { status: 401, headers: cors() });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let payload: Record<string, string> = {};
  try {
    if (contentType.includes("application/json")) {
      const json = (await request.json()) as Record<string, unknown>;
      payload = Object.fromEntries(Object.entries(json).map(([k, v]) => [k, v == null ? "" : String(v)]));
    } else {
      const form = await request.formData();
      payload = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read the submission." }, { status: 400, headers: cors() });
  }

  const slug = (request.headers.get("x-org-slug") ?? payload.org ?? "").trim();
  if (!slug) {
    return NextResponse.json({ ok: false, error: "Missing workspace slug (x-org-slug header or org field)." }, { status: 400, headers: cors() });
  }

  const org = get<{ id: string; suspended_at: string | null }>(
    "select id, suspended_at from organizations where slug = ?",
    [slug]
  );
  if (!org || org.suspended_at) {
    return NextResponse.json({ ok: false, error: "Unknown or inactive workspace." }, { status: 404, headers: cors() });
  }

  const name = (payload.name ?? "").trim();
  const email = (payload.email ?? "").trim().toLowerCase();
  if (!name && !email) {
    return NextResponse.json({ ok: false, error: "Provide at least a name or an email address." }, { status: 422, headers: cors() });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ ok: false, error: "That email address looks invalid." }, { status: 422, headers: cors() });
  }

  const limit = checkLeadLimit(org.id);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: limit.reason ?? "Lead limit reached." }, { status: 402, headers: cors() });
  }

  const id = newId();
  const now = nowIso();
  const valueCents = Math.max(0, Math.round(Number((payload.value ?? "0").replace(/[^0-9.\-]/g, "")) * 100)) || 0;

  run(
    `insert into leads (id, organization_id, name, email, phone, company, source, status, value_cents, notes, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, org.id, name || email, email || null, (payload.phone ?? "").trim() || null,
      (payload.company ?? "").trim() || null, (payload.source ?? "website").trim().slice(0, 60),
      "new", valueCents, (payload.message ?? payload.notes ?? "").trim().slice(0, 2000) || null, now, now,
    ]
  );
  recordUsage(org.id, "lead");
  logActivity({ organizationId: org.id, actorId: null, entityType: "lead", entityId: id, action: "lead.captured", summary: `Lead captured from ${payload.source ?? "website"}` });
  audit({ organizationId: org.id, action: "lead.capture", targetType: "lead", targetId: id, ip });

  try {
    await dispatchTrigger(org.id, "lead.created", { type: "lead", id, data: { id, name, email, source: payload.source ?? "website" } }, {});
  } catch { /* a failing automation must not lose the lead */ }

  return NextResponse.json({ ok: true, id }, { status: 201, headers: cors() });
}
