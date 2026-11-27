import { appUrl } from "@/lib/app-url";
import crypto from "node:crypto";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/logger";

/**
 * Per-workspace third-party credentials (currently Dropbox).
 *
 * The old behaviour was one global `DROPBOX_ACCESS_TOKEN` for the whole deploy,
 * which means every customer's files landed in one Dropbox account — fine for a
 * demo, wrong for a SaaS. A workspace now connects its own Dropbox through OAuth
 * and the token is stored per organisation.
 *
 * DROPBOX_TOKEN_URL exists so the exchange can be pointed at a local double; the
 * tests use exactly the code path production uses.
 */

export type IntegrationProvider = "dropbox";

export type DropboxCredential = {
  organization_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  account_label: string | null;
};

export function dropboxAppConfigured(): boolean {
  return (
    (process.env.DROPBOX_APP_KEY ?? "").trim().length > 0 &&
    (process.env.DROPBOX_APP_SECRET ?? "").trim().length > 0
  );
}

export function redirectUri(): string {
  return (
    (process.env.DROPBOX_REDIRECT_URI ?? "").trim() ||
    `${appUrl()}/api/integrations/dropbox/callback`
  );
}

/** The URL the user is sent to; `state` binds the callback to this browser. */
export function dropboxAuthorizeUrl(state: string): string {
  const base = (process.env.DROPBOX_AUTHORIZE_URL ?? "https://www.dropbox.com/oauth2/authorize").trim();
  const params = new URLSearchParams({
    client_id: (process.env.DROPBOX_APP_KEY ?? "").trim(),
    response_type: "code",
    // offline = issue a refresh token, so uploads keep working after 4 hours.
    token_access_type: "offline",
    redirect_uri: redirectUri(),
    state,
  });
  return `${base}?${params.toString()}`;
}

function stateSecret(): string {
  return (process.env.SESSION_SECRET ?? "").trim() || "bizpilot-dev-insecure-state-secret";
}

/** HMAC-signed, time-bounded state — no server-side storage needed. */
export function signState(payload: { organization_id: string; user_id: string; nonce?: string }, ttlMs = 10 * 60_000) {
  const body = {
    organization_id: payload.organization_id,
    user_id: payload.user_id,
    nonce: payload.nonce ?? crypto.randomBytes(8).toString("hex"),
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const mac = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export type StateResult =
  | { ok: true; organization_id: string; user_id: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyState(state: string | null): StateResult {
  if (!state || !state.includes(".")) return { ok: false, reason: "malformed" };
  const [encoded, mac] = state.split(".");
  const expected = crypto.createHmac("sha256", stateSecret()).update(encoded).digest("base64url");
  const a = Buffer.from(mac ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  try {
    const body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      organization_id?: string;
      user_id?: string;
      exp?: number;
    };
    if (!body.organization_id || !body.user_id) return { ok: false, reason: "malformed" };
    if (!body.exp || Date.now() > body.exp) return { ok: false, reason: "expired" };
    return { ok: true, organization_id: body.organization_id, user_id: body.user_id };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export type TokenExchangeResult =
  | { ok: true; access_token: string; refresh_token: string | null; expires_at: string | null; account_id: string | null }
  | { ok: false; message: string };

/** Exchanges an authorisation code for tokens. Never throws. */
export async function exchangeDropboxCode(code: string): Promise<TokenExchangeResult> {
  if (!dropboxAppConfigured()) {
    return { ok: false, message: "Dropbox is not configured: set DROPBOX_APP_KEY and DROPBOX_APP_SECRET." };
  }
  const endpoint = (process.env.DROPBOX_TOKEN_URL ?? "https://api.dropboxapi.com/oauth2/token").trim();
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: (process.env.DROPBOX_APP_KEY ?? "").trim(),
    client_secret: (process.env.DROPBOX_APP_SECRET ?? "").trim(),
    redirect_uri: redirectUri(),
  });
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `Dropbox token exchange failed (${res.status}): ${detail.slice(0, 200)}` };
    }
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      account_id?: string;
    };
    if (!data.access_token) return { ok: false, message: "Dropbox returned no access token." };
    return {
      ok: true,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_at: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
      account_id: data.account_id ?? null,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Dropbox token exchange failed" };
  }
}

export function saveCredential(input: {
  organizationId: string;
  provider: IntegrationProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  accountLabel: string | null;
  createdBy: string | null;
}) {
  const now = nowIso();
  const existing = get<{ id: string }>(
    "select id from integration_credentials where organization_id = ? and provider = ?",
    [input.organizationId, input.provider]
  );
  if (existing) {
    run(
      `update integration_credentials set access_token = ?, refresh_token = ?, expires_at = ?, account_label = ?, updated_at = ?
        where id = ?`,
      [input.accessToken, input.refreshToken, input.expiresAt, input.accountLabel, now, existing.id]
    );
    return existing.id;
  }
  const id = newId();
  run(
    `insert into integration_credentials (id, organization_id, provider, access_token, refresh_token, expires_at,
       account_label, scopes, created_by, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, input.organizationId, input.provider, input.accessToken, input.refreshToken, input.expiresAt,
      input.accountLabel, null, input.createdBy, now, now,
    ]
  );
  return id;
}

export function getCredential(organizationId: string, provider: IntegrationProvider): DropboxCredential | null {
  return (
    get<DropboxCredential>(
      "select organization_id, access_token, refresh_token, expires_at, account_label from integration_credentials where organization_id = ? and provider = ?",
      [organizationId, provider]
    ) ?? null
  );
}

export function deleteCredential(organizationId: string, provider: IntegrationProvider) {
  run("delete from integration_credentials where organization_id = ? and provider = ?", [organizationId, provider]);
}

/**
 * A usable access token for this workspace, refreshing it when it is about to
 * expire. Returns null when the workspace has not connected Dropbox — callers then
 * fall back to the deployment-level token (self-hosted) or to local storage.
 */
export async function dropboxAccessTokenFor(organizationId: string): Promise<string | null> {
  const credential = getCredential(organizationId, "dropbox");
  if (!credential) return null;

  const expiresSoon =
    credential.expires_at !== null && new Date(credential.expires_at).getTime() - Date.now() < 60_000;
  if (!expiresSoon && credential.access_token) return credential.access_token;
  if (!credential.refresh_token) return credential.access_token;

  const endpoint = (process.env.DROPBOX_TOKEN_URL ?? "https://api.dropboxapi.com/oauth2/token").trim();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh_token,
        client_id: (process.env.DROPBOX_APP_KEY ?? "").trim(),
        client_secret: (process.env.DROPBOX_APP_SECRET ?? "").trim(),
      }).toString(),
    });
    if (!res.ok) {
      logger.warn("dropbox token refresh failed", { organizationId, status: res.status });
      return credential.access_token;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return credential.access_token;
    saveCredential({
      organizationId,
      provider: "dropbox",
      accessToken: data.access_token,
      refreshToken: credential.refresh_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
      accountLabel: credential.account_label,
      createdBy: null,
    });
    return data.access_token;
  } catch (error) {
    logger.warn("dropbox token refresh error", { organizationId, error: error instanceof Error ? error.message : String(error) });
    return credential.access_token;
  }
}
