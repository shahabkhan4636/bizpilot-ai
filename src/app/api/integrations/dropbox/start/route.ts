import { appUrl as appUrlBase } from "@/lib/app-url";
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { dropboxAppConfigured, dropboxAuthorizeUrl, signState } from "@/lib/integrations";
import { logger } from "@/lib/logger";

/**
 * Step 1 of connecting a workspace's Dropbox: send the user to Dropbox with a
 * signed `state` that ties the callback to this user and organisation.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const appUrl = appUrlBase();
  const back = (query: string) => NextResponse.redirect(`${appUrl}/documents?${query}`, { status: 303 });

  let ctx;
  try {
    ctx = await requireAuth();
  } catch {
    return NextResponse.redirect(`${appUrl}/login?next=/documents`, { status: 303 });
  }

  if (!can(ctx.membership.role, "settings:workspace")) {
    return back("dropbox=forbidden");
  }
  if (!dropboxAppConfigured()) {
    return back("dropbox=not_configured");
  }

  const state = signState({ organization_id: ctx.membership.organization_id, user_id: ctx.user.id });
  logger.info("dropbox connect started", { organizationId: ctx.membership.organization_id, userId: ctx.user.id });
  return NextResponse.redirect(dropboxAuthorizeUrl(state), { status: 303 });
}
