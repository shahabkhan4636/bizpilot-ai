import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { run, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import {
  signState,
  verifyState,
  exchangeDropboxCode,
  saveCredential,
  getCredential,
  deleteCredential,
  dropboxAccessTokenFor,
  dropboxAppConfigured,
  dropboxAuthorizeUrl,
} from "@/lib/integrations";

/*
 * Dropbox connect flow, exercised end to end against a real HTTP server standing
 * in for api.dropboxapi.com/oauth2/token.
 */

let server: http.Server;
let tokenUrl = "";
let replies: { status: number; body: string }[] = [];
let requests: { path: string; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push({ path: req.url ?? "", body });
      const reply = replies.shift() ?? { status: 500, body: "{}" };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth2/token`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetDatabaseForTests();
  replies = [];
  requests = [];
  vi.unstubAllEnvs();
  vi.stubEnv("DROPBOX_APP_KEY", "appkey");
  vi.stubEnv("DROPBOX_APP_SECRET", "appsecret");
  vi.stubEnv("DROPBOX_TOKEN_URL", tokenUrl);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3100");
});

function seedOrg(): string {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `int-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@example.com`, "x", "Integration Test", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, "Org", slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, "professional", "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return orgId;
}

describe("oauth state", () => {
  it("round-trips a signed state for its own workspace", () => {
    const orgId = seedOrg();
    const state = signState({ organization_id: orgId, user_id: "user-1" });
    const verified = verifyState(state);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected valid state");
    expect(verified.organization_id).toBe(orgId);
    expect(verified.user_id).toBe("user-1");
  });

  it("rejects a tampered state — a crafted link cannot attach Dropbox to another workspace", () => {
    const orgA = seedOrg();
    const orgB = seedOrg();
    const state = signState({ organization_id: orgA, user_id: "user-1" });
    const mac = state.split(".")[1];
    const forgedPayload = Buffer.from(
      JSON.stringify({ organization_id: orgB, user_id: "user-1", nonce: "x", exp: Date.now() + 60_000 })
    ).toString("base64url");
    const forged = `${forgedPayload}.${mac}`;
    const verified = verifyState(forged);
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("expected rejection");
    expect(verified.reason).toBe("bad_signature");
  });

  it("expires an old state and rejects junk", () => {
    const expired = signState({ organization_id: "org", user_id: "u" }, -1000);
    const expiredResult = verifyState(expired);
    expect(expiredResult.ok).toBe(false);
    if (!expiredResult.ok) expect(expiredResult.reason).toBe("expired");
    expect(verifyState(null).ok).toBe(false);
    expect(verifyState("garbage").ok).toBe(false);
  });
});

describe("dropbox configuration", () => {
  it("only claims to be configured when both key and secret exist", () => {
    expect(dropboxAppConfigured()).toBe(true);
    vi.stubEnv("DROPBOX_APP_SECRET", "");
    expect(dropboxAppConfigured()).toBe(false);
  });

  it("builds an authorize url that requests offline access and carries the state", () => {
    const url = new URL(dropboxAuthorizeUrl("state-123"));
    expect(url.searchParams.get("client_id")).toBe("appkey");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toContain("/api/integrations/dropbox/callback");
  });
});

describe("code exchange", () => {
  it("stores the tokens returned by the provider", async () => {
    replies = [
      {
        status: 200,
        body: JSON.stringify({
          access_token: "sl.abc",
          refresh_token: "rt.xyz",
          expires_in: 14400,
          account_id: "dbid:123",
        }),
      },
    ];
    const exchanged = await exchangeDropboxCode("auth-code");
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) throw new Error("expected success");
    expect(exchanged.access_token).toBe("sl.abc");
    expect(exchanged.refresh_token).toBe("rt.xyz");
    expect(exchanged.expires_at).toBeTruthy();
    // The request really was a form-encoded authorization_code grant.
    expect(requests[0].body).toContain("grant_type=authorization_code");
    expect(requests[0].body).toContain("code=auth-code");
  });

  it("surfaces a provider rejection instead of pretending to be connected", async () => {
    replies = [{ status: 400, body: JSON.stringify({ error: "invalid_grant" }) }];
    const exchanged = await exchangeDropboxCode("bad-code");
    expect(exchanged.ok).toBe(false);
    if (exchanged.ok) throw new Error("expected failure");
    expect(exchanged.message).toContain("400");
    expect(exchanged.message).toContain("invalid_grant");
  });

  it("refuses to exchange when the app keys are missing", async () => {
    vi.stubEnv("DROPBOX_APP_KEY", "");
    const exchanged = await exchangeDropboxCode("code");
    expect(exchanged.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("per-workspace credentials", () => {
  it("keeps each workspace's connection separate", () => {
    const orgA = seedOrg();
    const orgB = seedOrg();
    saveCredential({
      organizationId: orgA, provider: "dropbox", accessToken: "token-a", refreshToken: "refresh-a",
      expiresAt: null, accountLabel: "dbid:a", createdBy: null,
    });
    expect(getCredential(orgA, "dropbox")?.access_token).toBe("token-a");
    expect(getCredential(orgB, "dropbox")).toBeNull();
  });

  it("updates rather than duplicating on reconnect", () => {
    const orgId = seedOrg();
    saveCredential({
      organizationId: orgId, provider: "dropbox", accessToken: "first", refreshToken: "r1",
      expiresAt: null, accountLabel: "dbid:1", createdBy: null,
    });
    saveCredential({
      organizationId: orgId, provider: "dropbox", accessToken: "second", refreshToken: "r2",
      expiresAt: null, accountLabel: "dbid:2", createdBy: null,
    });
    const credential = getCredential(orgId, "dropbox");
    expect(credential?.access_token).toBe("second");
    expect(credential?.refresh_token).toBe("r2");
  });

  it("returns an access token for the connected workspace and null for others", async () => {
    const orgA = seedOrg();
    const orgB = seedOrg();
    saveCredential({
      organizationId: orgA, provider: "dropbox", accessToken: "live-token", refreshToken: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountLabel: null, createdBy: null,
    });
    expect(await dropboxAccessTokenFor(orgA)).toBe("live-token");
    expect(await dropboxAccessTokenFor(orgB)).toBeNull();
  });

  it("refreshes an expired token and stores the new one", async () => {
    const orgId = seedOrg();
    saveCredential({
      organizationId: orgId, provider: "dropbox", accessToken: "stale", refreshToken: "rt.1",
      expiresAt: new Date(Date.now() - 60_000).toISOString(), accountLabel: null, createdBy: null,
    });
    replies = [{ status: 200, body: JSON.stringify({ access_token: "fresh", expires_in: 14400 }) }];

    const token = await dropboxAccessTokenFor(orgId);
    expect(token).toBe("fresh");
    expect(requests[0].body).toContain("grant_type=refresh_token");
    expect(getCredential(orgId, "dropbox")?.access_token).toBe("fresh");
  });

  it("disconnecting removes the credential", () => {
    const orgId = seedOrg();
    saveCredential({
      organizationId: orgId, provider: "dropbox", accessToken: "t", refreshToken: null,
      expiresAt: null, accountLabel: null, createdBy: null,
    });
    deleteCredential(orgId, "dropbox");
    expect(getCredential(orgId, "dropbox")).toBeNull();
  });
});
