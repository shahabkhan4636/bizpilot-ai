import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { all } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import { audit } from "@/lib/audit";
import { LEAD_STATUS_LABEL, type LeadStatus } from "@/lib/csv";

/** CSV export of the current filtered view. Tenant-scoped by requireAuth + organization_id. */
export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireAuth();
  } catch {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const orgId = ctx.membership.organization_id;
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  const status = url.searchParams.get("status");
  const owner = url.searchParams.get("owner");

  const where = ["l.organization_id = ?", "l.deleted_at is null"];
  const params: unknown[] = [orgId];
  if (q) {
    where.push("(l.name like ? or l.email like ? or l.company like ? or l.phone like ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status && status in LEAD_STATUS_LABEL) {
    where.push("l.status = ?");
    params.push(status);
  }
  if (owner) {
    where.push("l.assigned_to = ?");
    params.push(owner);
  }

  const rows = all<{
    name: string; email: string | null; phone: string | null; company: string | null;
    source: string; status: LeadStatus; value_cents: number; ai_score: number | null;
    notes: string | null; created_at: string;
  }>(
    `select name, email, phone, company, source, status, value_cents, ai_score, notes, created_at
       from leads l where ${where.join(" and ")} order by created_at desc`,
    params
  );

  const csv = toCsv(
    ["name", "email", "phone", "company", "source", "status", "value", "ai_score", "notes", "created_at"],
    rows.map((r) => [
      r.name,
      r.email ?? "",
      r.phone ?? "",
      r.company ?? "",
      r.source,
      r.status,
      (r.value_cents / 100).toFixed(2),
      r.ai_score === null ? "" : String(r.ai_score),
      r.notes ?? "",
      r.created_at,
    ])
  );

  audit({ organizationId: orgId, actorId: ctx.user.id, action: "lead.export", metadata: { rows: rows.length } });

  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
