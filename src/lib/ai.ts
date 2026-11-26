/**
 * AI provider abstraction.
 *
 * Works with any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, local vLLM…).
 * If AI_API_KEY is missing we return a structured `not_configured` result — we never
 * fabricate generated content and never claim a message was produced by a model.
 */

export type AiResult =
  | { ok: true; text: string; model: string; provider: string }
  | { ok: false; code: "not_configured" | "provider_error" | "rate_limited" | "empty"; message: string };

export function aiConfig() {
  return {
    apiKey: process.env.AI_API_KEY ?? "",
    baseUrl: (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.AI_MODEL ?? "gpt-4o-mini",
  };
}

export function isAiConfigured(): boolean {
  return aiConfig().apiKey.trim().length > 0;
}

type GenerateOptions = {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  timeoutMs?: number;
};

export async function generateText(options: GenerateOptions): Promise<AiResult> {
  const cfg = aiConfig();
  if (!isAiConfigured()) {
    return {
      ok: false,
      code: "not_configured",
      message: "AI is not configured. Add AI_API_KEY to your environment to enable generation.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: options.temperature ?? 0.6,
        max_tokens: options.maxTokens ?? 900,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.prompt },
        ],
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      return { ok: false, code: "rate_limited", message: "The AI provider rate-limited this request. Try again in a moment." };
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        code: "provider_error",
        message: `AI provider returned ${res.status}. ${detail.slice(0, 200)}`.trim(),
      };
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { ok: false, code: "empty", message: "The AI provider returned an empty response." };

    return { ok: true, text, model: data.model ?? cfg.model, provider: new URL(cfg.baseUrl).host };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AI error";
    return {
      ok: false,
      code: "provider_error",
      message: message.includes("aborted") ? "The AI request timed out." : message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ */
/* Lead scoring                                                        */
/* ------------------------------------------------------------------ */

export type ScorableLead = {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: string | null;
  status?: string | null;
  value_cents?: number | null;
  notes?: string | null;
};

export type LeadScore = {
  score: number;
  reason: string;
  nextAction: string;
  approach: string;
  method: "ai" | "rules";
};

const SOURCE_WEIGHT: Record<string, number> = {
  referral: 30,
  website: 22,
  web: 22,
  "public-form": 20,
  form: 20,
  import: 12,
  manual: 10,
  cold: 6,
  ad: 14,
  ads: 14,
};

/**
 * Transparent, deterministic scoring used when AI is not configured.
 * The UI labels this as "rule-based", never as AI output.
 */
export function ruleBasedLeadScore(lead: ScorableLead): LeadScore {
  let score = 25;
  const reasons: string[] = [];

  const source = (lead.source ?? "manual").toLowerCase();
  const sourcePoints = SOURCE_WEIGHT[source] ?? 10;
  score += sourcePoints;
  reasons.push(`Source "${source}" contributes ${sourcePoints} points`);

  if (lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email)) {
    score += 12;
    reasons.push("valid business email supplied");
  } else {
    score -= 8;
    reasons.push("no valid email on file");
  }

  if (lead.phone) {
    score += 8;
    reasons.push("phone number supplied");
  }

  if (lead.company) {
    score += 10;
    reasons.push("company identified");
  }

  const value = (lead.value_cents ?? 0) / 100;
  if (value >= 5000) {
    score += 20;
    reasons.push(`high deal value ($${value.toLocaleString()})`);
  } else if (value >= 1000) {
    score += 12;
    reasons.push(`mid deal value ($${value.toLocaleString()})`);
  } else if (value > 0) {
    score += 4;
    reasons.push(`small deal value ($${value.toLocaleString()})`);
  }

  const notesLen = (lead.notes ?? "").length;
  if (notesLen > 80) {
    score += 6;
    reasons.push("detailed notes captured");
  }

  const status = (lead.status ?? "new").toLowerCase();
  const statusBonus: Record<string, number> = { contacted: 6, qualified: 18, proposal_sent: 22, negotiation: 26 };
  if (statusBonus[status]) {
    score += statusBonus[status]!;
    reasons.push(`status "${status}" indicates progress`);
  }
  if (status === "won") score = 100;
  if (status === "lost") score = Math.min(score, 10);

  score = Math.max(0, Math.min(100, Math.round(score)));

  const nextAction =
    score >= 75
      ? "Call within 24 hours and send a tailored proposal the same day."
      : score >= 50
        ? "Send a personalised intro email, then follow up in 3 days."
        : score >= 30
          ? "Add to a nurture sequence and try a discovery call this week."
          : "Keep in a light-touch nurture list; verify contact details first.";

  const approach =
    score >= 75
      ? "Direct and consultative — lead the conversation with outcomes and pricing."
      : score >= 50
        ? "Helpful and specific — lead with the problem you solve, not the price."
        : "Educational and low-pressure — share value before asking for time.";

  return {
    score,
    reason: `Rule-based score: ${reasons.join("; ")}.`,
    nextAction,
    approach,
    method: "rules",
  };
}

export async function scoreLead(lead: ScorableLead): Promise<LeadScore> {
  if (!isAiConfigured()) return ruleBasedLeadScore(lead);

  const result = await generateText({
    system:
      "You are a B2B sales analyst. Score leads objectively. Reply with JSON only, keys: " +
      'score (integer 0-100), reason (string, max 320 chars), nextAction (string, max 200 chars), approach (string, max 200 chars). ' +
      "Never invent facts that were not provided. If information is missing, say so in the reason.",
    prompt: JSON.stringify({
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.company,
      source: lead.source,
      status: lead.status,
      deal_value_usd: ((lead.value_cents ?? 0) / 100).toFixed(2),
      notes: lead.notes,
    }),
    json: true,
    temperature: 0.2,
    maxTokens: 400,
  });

  if (!result.ok) return ruleBasedLeadScore(lead);

  try {
    const parsed = JSON.parse(result.text) as { score?: number; reason?: string; nextAction?: string; approach?: string };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score ?? 0))));
    if (!Number.isFinite(score)) return ruleBasedLeadScore(lead);
    return {
      score,
      reason: String(parsed.reason ?? "No reason supplied by the model.").slice(0, 400),
      nextAction: String(parsed.nextAction ?? "").slice(0, 240),
      approach: String(parsed.approach ?? "").slice(0, 240),
      method: "ai",
    };
  } catch {
    return ruleBasedLeadScore(lead);
  }
}

/* ------------------------------------------------------------------ */
/* Content generation prompts                                          */
/* ------------------------------------------------------------------ */

export const AI_KINDS = [
  "sales_email",
  "follow_up",
  "reply",
  "proposal",
  "service_description",
  "quotation",
  "introduction",
  "appointment_confirmation",
  "support_reply",
] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const AI_KIND_LABEL: Record<AiKind, string> = {
  sales_email: "Sales email",
  follow_up: "Follow-up message",
  reply: "Customer reply",
  proposal: "Sales proposal",
  service_description: "Service description",
  quotation: "Professional quotation",
  introduction: "Business introduction",
  appointment_confirmation: "Appointment confirmation",
  support_reply: "Support response",
};

export type ContentBrief = {
  kind: AiKind;
  businessName: string;
  services: string;
  tone: string;
  language: string;
  objective: string;
  customerName: string;
  customerCompany?: string;
  customerNotes?: string;
  pricing?: string;
  extra?: string;
};

export function buildContentPrompt(brief: ContentBrief): { system: string; prompt: string } {
  const system =
    "You are a senior B2B copywriter for small businesses. Write clear, specific, human copy. " +
    "Never invent facts, testimonials, customer names, prices or guarantees that were not supplied. " +
    "Return plain text only — no markdown headings, no placeholders like [Your Name].";

  const prompt = [
    `Task: write a ${AI_KIND_LABEL[brief.kind]} (${brief.kind}).`,
    `Business: ${brief.businessName}`,
    `Services: ${brief.services || "(not specified)"}`,
    `Tone: ${brief.tone}`,
    `Language: ${brief.language}`,
    `Objective: ${brief.objective || "(not specified)"}`,
    `Customer: ${brief.customerName}${brief.customerCompany ? ` (${brief.customerCompany})` : ""}`,
    brief.customerNotes ? `Customer context: ${brief.customerNotes}` : "",
    brief.pricing ? `Pricing: ${brief.pricing}` : "",
    brief.extra ? `Additional instructions: ${brief.extra}` : "",
    "Keep it under 300 words unless the task is a proposal or quotation.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, prompt };
}
