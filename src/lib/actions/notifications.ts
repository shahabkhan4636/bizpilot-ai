"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth";
import { markAllRead, markRead } from "@/lib/notifications";

/**
 * Read state is the one mutation that is NOT behind the impersonation write gate.
 *
 * It changes no tenant record — only the acting user's own "seen" flag on a row that
 * is already visible to them — and refusing it would leave a support session staring
 * at an inbox it cannot clear. Flagged here so the exemption is a decision on the
 * record rather than an oversight.
 */
export async function markNotificationReadAction(form: FormData): Promise<void> {
  const { user, membership } = await requireAuth();
  const id = String(form.get("id") ?? "");
  if (id) markRead(membership.organization_id, user.id, id);
  revalidatePath("/notifications");
  revalidatePath("/dashboard");
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const { user, membership } = await requireAuth();
  markAllRead(membership.organization_id, user.id);
  revalidatePath("/notifications");
  revalidatePath("/dashboard");
}
