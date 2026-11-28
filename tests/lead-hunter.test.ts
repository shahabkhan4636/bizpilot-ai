import { describe, expect, it, afterEach } from "vitest";
import {
  LEAD_HUNTER_MAX_MESSAGE_CHARS,
  leadHunterBusiness,
  leadHunterPrompt,
  leadSummary,
  leadHunterSystemPrompt,
  splitLeadJson,
} from "@/lib/lead-hunter";

const ENV_KEYS = [
  "LEADHUNTER_BUSINESS_NAME",
  "LEADHUNTER_OFFER",
  "LEADHUNTER_RESULT",
  "LEADHUNTER_MAGNET",
  "LEADHUNTER_CALENDAR_LINK",
  "LEADHUNTER_TIMEZONE",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("leadHunterBusiness", () => {
  it("falls back to the Shahab Studio defaults", () => {
    const b = leadHunterBusiness();
    expect(b.name).toBe("Shahab Studio");
    expect(b.calendar).toBe("");
    expect(b.offer.length).toBeGreaterThan(0);
  });

  it("reads every value from env and ignores blank strings", () => {
    process.env.LEADHUNTER_BUSINESS_NAME = "Acme Leads";
    process.env.LEADHUNTER_OFFER = "paid ads";
    process.env.LEADHUNTER_MAGNET = "free audit";
    process.env.LEADHUNTER_CALENDAR_LINK = "https://cal.com/acme/15min";
    process.env.LEADHUNTER_TIMEZONE = "US Central";
    const b = leadHunterBusiness();
    expect(b.name).toBe("Acme Leads");
    expect(b.offer).toBe("paid ads");
    expect(b.magnet).toBe("free audit");
    expect(b.calendar).toBe("https://cal.com/acme/15min");
    expect(b.timezone).toBe("US Central");

    // A blank value is treated as unset, so the built-in default applies — not the previous value.
    process.env.LEADHUNTER_BUSINESS_NAME = "   ";
    expect(leadHunterBusiness().name).toBe("Shahab Studio");
  });
});

describe("leadHunterSystemPrompt", () => {
  it("contains the one-question rule, the BANT order and the CRM contract", () => {
    const prompt = leadHunterSystemPrompt();
    expect(prompt).toContain("Exactly ONE question per message");
    for (const step of ["NEED", "BUDGET", "AUTHORITY", "TIMELINE"]) expect(prompt).toContain(step);
    expect(prompt).toContain("<lead_json>");
    expect(prompt).toContain("Never claim to be human");
  });

  it("tells the model to ask for contact details instead of inventing a booking link", () => {
    const prompt = leadHunterSystemPrompt();
    expect(prompt).toContain("Do not invent a booking link");
    expect(prompt).not.toContain("Share this booking link when the lead is hot");

    process.env.LEADHUNTER_CALENDAR_LINK = "https://cal.com/acme/15min";
    expect(leadHunterSystemPrompt()).toContain("Share this booking link when the lead is hot: https://cal.com/acme/15min");
  });
});

describe("leadHunterPrompt", () => {
  it("renders the transcript with speaker labels and a single next-message request", () => {
    const prompt = leadHunterPrompt([
      { role: "assistant", content: "Hey!" },
      { role: "user", content: "I need more leads" },
    ]);
    expect(prompt).toContain("LeadHunter: Hey!");
    expect(prompt).toContain("Visitor: I need more leads");
    expect(prompt.trim().endsWith("Write only your next message to the visitor.")).toBe(true);
  });
});

describe("splitLeadJson", () => {
  it("keeps plain replies untouched and creates no lead", () => {
    const { text, lead } = splitLeadJson("What's your biggest blocker right now?");
    expect(text).toBe("What's your biggest blocker right now?");
    expect(lead).toBeNull();
  });

  it("strips the block and normalises a valid lead record", () => {
    const reply = `Booked — talk tomorrow at 10.\n<lead_json>
    {"score": 9.4, "status": "HOT", "name": "  Ali  ", "email": "Ali@Example.COM", "phone": "03001234567",
     "budget": "150k-400k", "need": "more leads", "timeline": "this month", "next_action": "booked", "notes": "ready to pay"}
    </lead_json>`;
    const { text, lead } = splitLeadJson(reply);
    expect(text).toBe("Booked — talk tomorrow at 10.");
    expect(lead).not.toBeNull();
    expect(lead!.score).toBe(9);
    expect(lead!.status).toBe("hot");
    expect(lead!.name).toBe("Ali");
    expect(lead!.email).toBe("ali@example.com");
    expect(lead!.nextAction).toBe("booked");
  });

  it("clamps the score to 0-10 and rejects a malformed email", () => {
    const { lead } = splitLeadJson('<lead_json>{"score": 42, "status": "lukewarm", "email": "not-an-email"}</lead_json>');
    expect(lead!.score).toBe(10);
    expect(lead!.status).toBeUndefined();
    expect(lead!.email).toBeUndefined();
  });

  it("survives broken JSON and keeps the visible reply", () => {
    const { text, lead } = splitLeadJson("Sounds good.\n<lead_json>{not json</lead_json>");
    expect(text).toBe("Sounds good.");
    expect(lead).toBeNull();
  });

  it("ignores non-object JSON", () => {
    expect(splitLeadJson('<lead_json>[1,2,3]</lead_json>').lead).toBeNull();
    expect(splitLeadJson('<lead_json>"hot"</lead_json>').lead).toBeNull();
  });

  it("truncates very long fields instead of storing them whole", () => {
    const { lead } = splitLeadJson(`<lead_json>{"notes": "${"x".repeat(2000)}"}</lead_json>`);
    expect(lead!.notes!.length).toBe(600);
  });
});

describe("leadSummary", () => {
  it("joins the qualification facts into one line for leads.notes", () => {
    const summary = leadSummary({ need: "more leads", budget: "150k", timeline: "this month", score: 7, status: "warm", nextAction: "followup_24h" });
    expect(summary).toBe("Need: more leads · Budget: 150k · Timeline: this month · Score: 7/10 · Assessment: warm · Next: followup_24h");
  });

  it("skips empty fields and caps the length", () => {
    expect(leadSummary({ score: 3 })).toBe("Score: 3/10");
    expect(leadSummary({ notes: "y".repeat(3000) }).length).toBe(2000);
  });
});

describe("limits", () => {
  it("keeps the visitor message cap small enough to bound token cost", () => {
    expect(LEAD_HUNTER_MAX_MESSAGE_CHARS).toBeLessThanOrEqual(1000);
  });
});
