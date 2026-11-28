"use server";

import { headers } from "next/headers";
import { generateText, isAiConfigured } from "@/lib/ai";
import { audit, logActivity } from "@/lib/audit";
import { dispatchTrigger } from "@/lib/automations";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import {
  LEAD_HUNTER_MAX_MESSAGE_CHARS,
  LEAD_HUNTER_MAX_TRANSCRIPT_CHARS,
  LEAD_HUNTER_MAX_VISITOR_TURNS,
  leadHunterPrompt,
  leadHunterSystemPrompt,
  leadSummary,
  splitLeadJson,
  type ChatTurn,
  type LeadHunterLead,
} from "@/lib/lead-hunter";
import { checkLeadLimit, recordUsage } from "@/lib/plans";
import { rateLimit } from "@/lib/ratelimit";
import { nowIso } from "@/lib/utils";

export type ChatReply = { ok: true; reply: string; done: boolean } | { ok: false; error: string };

type Org = { id: string; name: string; suspended_at: string | null };

function cleanTranscript(input: unknown): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  const turns: ChatTurn[] = [];
  let budget = LEAD_HUNTER_MAX_TRANSCRIPT_CHARS;
  for (const raw of input.slice(-40)) {
    if (raw === null || typeof raw !== "object") continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const text = content.trim().slice(0, LEAD_HUNTER_MAX_MESSAGE_CHARS);
    if (!text) continue;
    budget -= text.length;
    if (budget < 0) break;
    turns.push({ role, content: text });
  }
  return turns;
}

/**
 * Saves a qualified visitor as a lead in the addressed workspace.
 *
 * Deliberately conservative:
 *   • no email → no lead (a chat alone is not a record the owner can act on),
 *   • an existing lead with the same email is not duplicated,
 *   • the plan's lead limit still applies, exactly as the public capture endpoint.
 */
function saveLead(org: Org, lead: LeadHunterLead, ip: string): { created: boolean; reason?: string } {
  if (!lead.email) return { created: false, reason: "no email captured yet" };

  const existing = get<{ id: string }>("select id from leads where organization_id = ? and lower(email) = ?", [org.id, lead.email]);
  if (existing) return { created: false, reason: "lead already exists" };

  const limit = checkLeadLimit(org.id);
  if (!limit.allowed) return { created: false, reason: limit.reason ?? "lead limit reached" };

  const id = newId();
  const now = nowIso();
  run(
    `insert into leads (id, organization_id, name, email, phone, company, source, status, value_cents, notes, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      org.id,
      lead.name ?? lead.email,
      lead.email,
      lead.phone ?? null,
      lead.company ?? null,
      "ai-chat",
      "new",
      0,
      leadSummary(lead) || null,
      now,
      now,
    ]
  );
  recordUsage(org.id, "lead");
  logActivity({
    organizationId: org.id,
    actorId: null,
    entityType: "lead",
    entityId: id,
    action: "lead.captured",
    summary: `Lead captured by the website chat${lead.score !== undefined ? ` (score ${lead.score}/10)` : ""}`,
  });
  audit({ organizationId: org.id, action: "lead.capture", targetType: "lead", targetId: id, ip });
  void dispatchTrigger(org.id, "lead.created", { type: "lead", id, data: { id, name: lead.name, email: lead.email, source: "ai-chat" } }, {}).catch(() => {
    /* a failing automation must never lose the lead */
  });
  return { created: true };
}

/**
 * One turn of the public chat. Called from the `/chat/[slug]` page through a server
 * action, so the browser never holds a key and cross-origin abuse is blocked by
 * Next's action origin check.
 */
export async function sendLeadHunterMessage(slug: string, transcript: unknown): Promise<ChatReply> {
  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

  const cleanSlug = typeof slug === "string" ? slug.trim().toLowerCase().slice(0, 80) : "";
  if (!cleanSlug) return { ok: false, error: "This chat link is incomplete." };

  const limited = rateLimit(`leadhunter:${ip}`, 30, 300);
  if (!limited.allowed) {
    return { ok: false, error: `That's a lot of messages — please try again in ${Math.max(1, Math.ceil(limited.resetInSeconds / 60))} minute(s), or email us instead.` };
  }

  if (!isAiConfigured()) {
    return { ok: false, error: "The assistant is not switched on yet. Please use the contact form instead." };
  }

  const org = get<Org>("select id, name, suspended_at from organizations where slug = ?", [cleanSlug]);
  if (!org || org.suspended_at) return { ok: false, error: "This chat is not available." };

  const turns = cleanTranscript(transcript);
  if (turns.length === 0 || turns[turns.length - 1].role !== "user") {
    return { ok: false, error: "Type a message to start." };
  }
  if (turns.filter((t) => t.role === "user").length > LEAD_HUNTER_MAX_VISITOR_TURNS) {
    return { ok: true, reply: "I'll stop here so I don't waste your time — the team will pick this up by email. Thanks for chatting!", done: true };
  }

  const result = await generateText({
    system: leadHunterSystemPrompt(),
    prompt: leadHunterPrompt(turns),
    maxTokens: 320,
    temperature: 0.4,
    timeoutMs: 25_000,
  });

  if (!result.ok) {
    return { ok: false, error: "The assistant could not answer just now. Please try again, or email us and we'll reply personally." };
  }

  const { text, lead } = splitLeadJson(result.text);
  let done = false;
  if (lead) {
    const outcome = saveLead(org, lead, ip);
    done = outcome.created || lead.nextAction === "booked" || lead.nextAction === "send_audit";
  }

  return { ok: true, reply: text || "Sorry — could you say that again?", done };
}
