import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * These tests put a real HTTP server in front of the provider clients.
 *
 * The point is not to mock `fetch` and assert it was called — it is to prove what
 * the app does with the answers a provider can actually give: 200, 429, 500,
 * malformed JSON, a slow socket. That is the difference between "the integration
 * exists" and "the integration behaves", and it is testable without a live key
 * because every provider URL is configurable.
 */

type Reply = { status: number; body: string; headers?: Record<string, string>; delayMs?: number };
type Recorded = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

let server: http.Server;
let baseUrl = "";
let queue: Reply[] = [];
let recorded: Recorded[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      recorded.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      const reply = queue.shift();
      if (!reply) {
        // No scripted reply left: fail loudly rather than hanging the test.
        res.writeHead(599, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no scripted reply" }));
        return;
      }
      const send = () => {
        res.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) });
        res.end(reply.body);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
  recorded = [];
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* AI provider                                                         */
/* ------------------------------------------------------------------ */

describe("AI provider client", () => {
  it("reports the model, provider and the provider's own token counts on success", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    vi.stubEnv("AI_MODEL", "stub-model");
    queue = [
      {
        status: 200,
        body: JSON.stringify({
          model: "stub-model-2026",
          choices: [{ message: { content: "  Hello from the stub  " } }],
          usage: { prompt_tokens: 120, completion_tokens: 45 },
        }),
      },
    ];
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.text).toBe("Hello from the stub");
    expect(result.model).toBe("stub-model-2026");
    expect(result.provider).toContain("127.0.0.1");
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 45 });

    // The request really was an OpenAI-compatible chat completion.
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].path).toBe("/chat/completions");
    expect(recorded[0].headers.authorization).toBe("Bearer test-key");
    const sent = JSON.parse(recorded[0].body) as { model: string; messages: { role: string }[] };
    expect(sent.model).toBe("stub-model");
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("retries a 500 and succeeds on the next attempt", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    vi.stubEnv("AI_RETRY_BASE_MS", "1");
    queue = [
      { status: 500, body: JSON.stringify({ error: "upstream exploded" }) },
      { status: 200, body: JSON.stringify({ choices: [{ message: { content: "recovered" } }] }) },
    ];
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(2);
  });

  it("retries a 429 but returns rate_limited when it never clears", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    vi.stubEnv("AI_MAX_ATTEMPTS", "2");
    vi.stubEnv("AI_RETRY_BASE_MS", "1");
    queue = [
      { status: 429, body: JSON.stringify({ error: "slow down" }) },
      { status: 429, body: JSON.stringify({ error: "slow down" }) },
    ];
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("rate_limited");
    expect(recorded).toHaveLength(2);
  });

  it("does not retry a 401 — a bad key is not a transient failure", async () => {
    vi.stubEnv("AI_API_KEY", "wrong-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    vi.stubEnv("AI_RETRY_BASE_MS", "1");
    queue = [{ status: 401, body: JSON.stringify({ error: { message: "Invalid API key" } }) }];
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("provider_error");
    expect(result.message).toContain("401");
    expect(result.message).toContain("Invalid API key");
    expect(recorded).toHaveLength(1);
  });

  it("treats an empty completion as empty, not as success", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    queue = [{ status: 200, body: JSON.stringify({ choices: [{ message: { content: "   " } }] }) }];
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("empty");
  });

  it("surfaces a non-JSON body instead of pretending the call worked", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    vi.stubEnv("AI_MAX_ATTEMPTS", "1");
    queue = [{ status: 200, body: "<html>gateway</html>" }];
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("provider_error");
  });

  it("says not_configured without making any request when there is no key", async () => {
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    const { generateText } = await import("@/lib/ai");
    const result = await generateText({ system: "s", prompt: "p" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("not_configured");
    expect(recorded).toHaveLength(0);
  });

  it("validates structured lead scoring output and clamps an out-of-range score", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    queue = [
      {
        status: 200,
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ score: 187, reason: "strong fit", nextAction: "call", approach: "email" }),
              },
            },
          ],
        }),
      },
    ];
    const { scoreLead } = await import("@/lib/ai");
    const scored = await scoreLead({ name: "Ada", email: "ada@example.com", company: "Analytical" });

    expect(scored.method).toBe("ai");
    expect(scored.score).toBe(100); // clamped, not 187
    expect(scored.reason).toBe("strong fit");
  });

  it("falls back to the rule-based score when the model returns prose instead of JSON", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", baseUrl);
    queue = [{ status: 200, body: JSON.stringify({ choices: [{ message: { content: "Sure! This lead looks great." } }] }) }];
    const { scoreLead } = await import("@/lib/ai");
    const scored = await scoreLead({ name: "Ada", email: "ada@example.com", company: "Analytical" });

    expect(scored.method).toBe("rules");
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.score).toBeLessThanOrEqual(100);
  });
});

/* ------------------------------------------------------------------ */
/* Email provider                                                      */
/* ------------------------------------------------------------------ */

describe("email provider client", () => {
  it("returns the provider's message id on a 200", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "BizPilot <no-reply@bizpilot.test>");
    vi.stubEnv("EMAIL_API_URL", `${baseUrl}/emails`);
    queue = [{ status: 200, body: JSON.stringify({ id: "msg_123" }) }];

    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({ to: "a@b.test", subject: "Hi", text: "Body" });

    expect(result).toEqual({ ok: true, id: "msg_123" });
    const sent = JSON.parse(recorded[0].body) as { from: string; to: string[]; subject: string };
    expect(sent.from).toBe("BizPilot <no-reply@bizpilot.test>");
    expect(sent.to).toEqual(["a@b.test"]);
    expect(recorded[0].headers.authorization).toBe("Bearer re_test");
  });

  it("never reports success when the provider rejects the message", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_API_URL", `${baseUrl}/emails`);
    queue = [
      {
        status: 422,
        body: JSON.stringify({ message: "The domain is not verified", name: "validation_error" }),
      },
    ];

    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({ to: "a@b.test", subject: "Hi", text: "Body" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("provider_error");
    expect(result.message).toContain("422");
    expect(result.message).toContain("domain is not verified");
  });

  it("reports not_configured without any network call when the key is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({ to: "a@b.test", subject: "Hi", text: "Body" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("not_configured");
    expect(recorded).toHaveLength(0);
  });

  it("reports a transport failure as provider_error rather than throwing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    // Port 9 (discard) on loopback: connection refused, nothing listening.
    vi.stubEnv("EMAIL_API_URL", "http://127.0.0.1:9/emails");
    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({ to: "a@b.test", subject: "Hi", text: "Body" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("provider_error");
  });
});

/* ------------------------------------------------------------------ */
/* Dropbox storage                                                     */
/* ------------------------------------------------------------------ */

describe("dropbox upload client", () => {
  it("returns the stored path on success", async () => {
    vi.stubEnv("DROPBOX_CONTENT_URL", `${baseUrl}/upload`);
    queue = [{ status: 200, body: JSON.stringify({ path_display: "/leads/contract.pdf" }) }];

    const { uploadToDropbox } = await import("@/lib/storage");
    const result = await uploadToDropbox("token", "/leads/contract.pdf", Buffer.from("pdf-bytes"));

    expect(result.ok).toBe(true);
    expect(result.path).toBe("/leads/contract.pdf");
    const apiArg = JSON.parse(String(recorded[0].headers["dropbox-api-arg"])) as { path: string };
    expect(apiArg.path).toBe("/leads/contract.pdf");
    expect(recorded[0].headers.authorization).toBe("Bearer token");
  });

  it("reports the provider's error instead of a silent failure", async () => {
    vi.stubEnv("DROPBOX_CONTENT_URL", `${baseUrl}/upload`);
    queue = [{ status: 409, body: JSON.stringify({ error_summary: "path/conflict/file" }) }];

    const { uploadToDropbox } = await import("@/lib/storage");
    const result = await uploadToDropbox("token", "/leads/contract.pdf", Buffer.from("x"));

    expect(result.ok).toBe(false);
    expect(result.message).toContain("409");
    expect(result.message).toContain("conflict");
  });
});
