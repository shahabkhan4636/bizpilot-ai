"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth";
import { markAllRead, markRead } from "@/lib/notifications";

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
