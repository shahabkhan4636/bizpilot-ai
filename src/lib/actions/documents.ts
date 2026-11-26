"use server";

import { revalidatePath } from "next/cache";
import { run, get } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { forbiddenRedirect, requirePermission } from "@/lib/authz";
import { audit, logActivity } from "@/lib/audit";
import { checkDocumentLimit, checkFeature } from "@/lib/plans";
import {
  saveFileLocal, deleteFileLocal, uploadToDropbox, isDropboxConfigured,
} from "@/lib/storage";
import { ValidationError, optionalStr } from "@/lib/validate";
import { dispatchTrigger } from "@/lib/automations";

export type DocumentState = { error?: string; notice?: string } | null;

function failState(e: unknown): DocumentState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = [
  "application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export async function uploadDocumentAction(_prev: DocumentState, form: FormData): Promise<DocumentState> {
  try {
    try {
      await requirePermission("document:upload");
    } catch (e) {
      return failState(e);
    }
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const feature = checkFeature(orgId, "documents");
    if (!feature.allowed) return { error: feature.reason ?? "Document storage is not included in your plan." };
    const limit = checkDocumentLimit(orgId);
    if (!limit.allowed) return { error: limit.reason ?? "Document limit reached." };

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file to upload.");
    if (file.size > MAX_BYTES) throw new ValidationError("Files must be 10 MB or smaller.");
    if (file.type && !ALLOWED.includes(file.type)) {
      throw new ValidationError(`Unsupported file type "${file.type}". Allowed: PDF, images, CSV, text, Word and Excel files.`);
    }

    const customerId = optionalStr(form.get("customer_id"), 60) || null;
    if (customerId && !get("select id from customers where id = ? and organization_id = ?", [customerId, orgId])) {
      throw new ValidationError("That customer does not belong to this workspace.");
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const stored = await saveFileLocal(file.name, bytes);
    let provider: "local" | "dropbox" = stored.provider;
    let storagePath = stored.path;
    let dropboxNote = "";

    // Real Dropbox upload only when a token is supplied; otherwise we stay honestly local.
    const token = (process.env.DROPBOX_ACCESS_TOKEN ?? "").trim();
    if (isDropboxConfigured() && token) {
      const result = await uploadToDropbox(token, `/${orgId}/${file.name}`, bytes);
      if (result.ok) {
        provider = "dropbox";
        storagePath = result.path ?? storagePath;
      } else {
        dropboxNote = ` Dropbox upload failed (${result.message ?? "unknown error"}), the file was kept locally.`;
      }
    } else if (isDropboxConfigured() && !token) {
      dropboxNote = " Dropbox app keys are set but no access token is present, so the file is stored locally.";
    }

    const id = newId();
    run(
      `insert into documents (id, organization_id, customer_id, uploaded_by, file_name, mime_type, size_bytes,
         storage_provider, storage_path, status, created_at)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, orgId, customerId, user.id, file.name.slice(0, 200), file.type || "application/octet-stream",
       file.size, provider, storagePath, "ready", nowIso()]
    );

    logActivity({ organizationId: orgId, actorId: user.id, entityType: "document", entityId: id, action: "document.uploaded", summary: `Uploaded "${file.name}"` });
    audit({ organizationId: orgId, actorId: user.id, action: "document.upload", targetType: "document", targetId: id, metadata: { provider } });
    try {
      await dispatchTrigger(orgId, "document.uploaded", { type: "document", id, data: { id, file_name: file.name, size_bytes: file.size } }, { actorId: user.id });
    } catch { /* non-fatal */ }

    revalidatePath("/documents");
    return { notice: `"${file.name}" uploaded (${provider === "dropbox" ? "Dropbox" : "local storage"}).${dropboxNote}` };
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: e instanceof Error ? e.message : "Upload failed." };
  }
}

export async function deleteDocumentAction(form: FormData): Promise<void> {
  try {
    await requirePermission("document:delete");
  } catch {
    forbiddenRedirect("document:delete");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const id = String(form.get("document_id") ?? "");
  const doc = get<{ id: string; storage_path: string; storage_provider: string }>(
    "select id, storage_path, storage_provider from documents where id = ? and organization_id = ?",
    [id, orgId]
  );
  if (!doc) return;
  if (doc.storage_provider === "local") {
    try {
      await deleteFileLocal(doc.storage_path);
    } catch { /* file may already be gone */ }
  }
  run("delete from documents where id = ? and organization_id = ?", [id, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "document.delete", targetType: "document", targetId: id });
  revalidatePath("/documents");
}
