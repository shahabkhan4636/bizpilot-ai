import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { verifyState, exchangeDropboxCode, saveCredential } from "@/lib/integrations";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * Step 2: Dropbox sends the user back with `code` and our `state`.
 *
 * The `state` signature is verified before the code is exchanged, and the
 * organisation in the state must be the caller's own — a link crafted for another
 * workspace cannot attach a Dropbox account to it.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  const back = (query: string) => NextResponse.redirect(`${appUrl}/documents?${query}`, { status: 303 });

  let ctx;
  try {
    ctx = await requireAuth();
  } catch {
    return NextResponse.redirect(`${appUrl}/login?next=/documents`, { status: 303 });
  }
  if (!can(ctx.membership.role, "settings:workspace")) return back("dropbox=forbidden");

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return back(`dropbox=denied`);

  const state = verifyState(url.searchParams.get("state"));
  if (!state.ok) {
    logger.warn("dropbox callback rejected state", { reason: state.reason });
    return back(`dropbox=state_${state.reason}`);
  }
  if (state.organization_id !== ctx.membership.organization_id || state.user_id !== ctx.user.id) {
    logger.warn("dropbox callback state belongs to another workspace", {
      stateOrg: state.organization_id,
      callerOrg: ctx.membership.organization_id,
    });
    return back("dropbox=state_mismatch");
  }

  const code = url.searchParams.get("code");
  if (!code) return back("dropbox=missing_code");

  const exchanged = await exchangeDropboxCode(code);
  if (!exchanged.ok) {
    logger.error("dropbox token exchange failed", { error: exchanged.message });
    // Reason is surfaced in the URL so the UI can show the real message instead of
    // a generic "something went wrong".
    return back(`dropbox=exchange_failed&reason=${encodeURIComponent(exchanged.message.slice(0, 160))}`);
  }

  saveCredential({
    organizationId: ctx.membership.organization_id,
    provider: "dropbox",
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token,
    expiresAt: exchanged.expires_at,
    accountLabel: exchanged.account_id,
    createdBy: ctx.user.id,
  });
  audit({
    organizationId: ctx.membership.organization_id,
    actorId: ctx.user.id,
    action: "integration.dropbox.connected",
    targetType: "integration",
    targetId: "dropbox",
  });
  logger.info("dropbox connected", { organizationId: ctx.membership.organization_id });
  return back("dropbox=connected");
}
