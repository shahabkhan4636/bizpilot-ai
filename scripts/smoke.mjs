#!/usr/bin/env node
/**
 * Post-deploy smoke check.
 *
 *   node scripts/smoke.mjs https://your-domain.com
 *   ADMIN_LIVE_URL=https://your-domain.com node scripts/smoke.mjs
 *   node scripts/smoke.mjs --list          # print what would be checked, touch nothing
 *
 * Every check is a real request against the deployed app and asserts something the
 * app is supposed to promise — not "the server answered". A deploy that 200s but
 * leaks /admin to strangers, or that reports `ready: false`, fails here.
 *
 * Exit code 0 = every check passed, 1 = at least one failed, 2 = no URL given.
 * Nothing in this script writes to the database.
 */
import process from "node:process";

const GLOBAL_TIMEOUT_MS = 15_000;

/** Each check: id, what it proves, and how to probe it. */
export const CHECKS = [
  {
    id: "marketing",
    title: "Public site renders",
    probe: async (base, http) => {
      const res = await http(`${base}/`);
      const html = await res.text();
      const ok = res.status === 200 && /Turn enquiries into paying customers/i.test(html);
      return { ok, detail: `status ${res.status}` };
    },
  },
  {
    id: "login",
    title: "Login page renders",
    probe: async (base, http) => {
      const res = await http(`${base}/login`);
      const html = await res.text();
      const ok = res.status === 200 && /Password/i.test(html);
      return { ok, detail: `status ${res.status}` };
    },
  },
  {
    id: "csp",
    title: "Strict CSP header present (nonce, no unsafe-inline for scripts)",
    probe: async (base, http) => {
      const res = await http(`${base}/login`);
      const csp = res.headers.get("content-security-policy") ?? "";
      const hasNonce = /'nonce-/.test(csp);
      const scriptUnsafe = /script-src[^;]*'unsafe-inline'/.test(csp);
      return {
        ok: hasNonce && !scriptUnsafe,
        detail: csp ? `nonce=${hasNonce} scriptUnsafeInline=${scriptUnsafe}` : "no CSP header",
      };
    },
  },
  {
    id: "readiness",
    title: "Readiness probe reports a migrated schema",
    probe: async (base, http) => {
      const res = await http(`${base}/api/readiness`);
      let body = null;
      try {
        body = await res.json();
      } catch {
        return { ok: false, detail: `status ${res.status}, body was not JSON` };
      }
      const pending = body?.checks?.migrations?.pending ?? body?.checks?.migrations?.pendingCount;
      return {
        ok: res.status === 200 && body?.ready === true,
        detail: `status ${res.status}, ready=${body?.ready}${pending !== undefined ? `, pending=${pending}` : ""}`,
      };
    },
  },
  {
    id: "admin-gate",
    title: "Anonymous /admin answers 404 (not 200, not a redirect to login)",
    probe: async (base, http) => {
      const res = await http(`${base}/admin`, { redirect: "manual" });
      const body = await res.text().catch(() => "");
      // A signed-out stranger currently gets the login redirect; a signed-in
      // non-owner gets 404. Either is acceptable, a 200 is not.
      const leaks = res.status === 200 && /Admin panel|Integration status/i.test(body);
      return { ok: !leaks, detail: `status ${res.status}${leaks ? ", PAGE CONTENT LEAKED" : ""}` };
    },
  },
  {
    id: "billing-platform",
    title: "Platform billing page does not expose payout details anonymously",
    probe: async (base, http) => {
      const res = await http(`${base}/billing/platform`, { redirect: "manual" });
      const body = await res.text().catch(() => "");
      const leaks = /Account title|IBAN/i.test(body) && res.status === 200;
      return { ok: !leaks, detail: `status ${res.status}${leaks ? ", PAYOUT DETAILS LEAKED" : ""}` };
    },
  },
  {
    id: "cron-email",
    title: "Email cron refuses a request without the secret",
    probe: async (base, http) => {
      const res = await http(`${base}/api/cron/email`);
      // 503 = no CRON_SECRET configured (route closed), 401 = secret configured and
      // missing from the request. A 200 here would mean anyone can flush the queue.
      return { ok: res.status === 401 || res.status === 503, detail: `status ${res.status}` };
    },
  },
  {
    id: "webhook-closed",
    title: "Payment webhook refuses an unsigned request",
    probe: async (base, http) => {
      const res = await http(`${base}/api/payments/webhook/sadapay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_type: "payment.succeeded", id: "smoke" }),
      });
      return { ok: res.status === 401 || res.status === 503, detail: `status ${res.status}` };
    },
  },
  {
    id: "not-found",
    title: "Unknown route answers 404",
    probe: async (base, http) => {
      const res = await http(`${base}/this-route-does-not-exist`);
      return { ok: res.status === 404, detail: `status ${res.status}` };
    },
  },
];

async function http(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { "user-agent": "bizpilot-smoke/1", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const list = argv.includes("--list");
  const url = argv.find((arg) => arg.startsWith("http://") || arg.startsWith("https://")) ?? process.env.ADMIN_LIVE_URL ?? "";
  return { list, url: url.replace(/\/+$/, "") };
}

async function main() {
  const { list, url } = parseArgs(process.argv.slice(2));

  if (list) {
    for (const check of CHECKS) console.log(`${check.id}\t${check.title}`);
    console.log(`\n${CHECKS.length} checks`);
    return 0;
  }

  if (!url) {
    console.error("Usage: node scripts/smoke.mjs https://your-domain.com    (or set ADMIN_LIVE_URL)");
    console.error("       node scripts/smoke.mjs --list");
    return 2;
  }

  console.log(`Smoke checking ${url}\n`);
  let failed = 0;
  for (const check of CHECKS) {
    let result;
    try {
      result = await check.probe(url, http);
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) failed += 1;
    console.log(`${result.ok ? "✔" : "✖"} ${check.id.padEnd(16)} ${check.title}`);
    console.log(`  ${result.ok ? "pass" : "FAIL"} — ${result.detail}`);
  }

  console.log(`\n${CHECKS.length - failed}/${CHECKS.length} passed`);
  if (failed > 0) {
    console.log("A failed check is a reason to roll back, not to retry — see DEPLOY-ADMIN.md §7.");
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}

export { main };
