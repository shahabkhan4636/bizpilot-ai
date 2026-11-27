"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run, get } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { forbiddenRedirect, requirePermission } from "@/lib/authz";
import { audit, logActivity } from "@/lib/audit";
import { checkDocumentLimit, checkFeature } from "@/lib/plans";
import {
  saveFileLocal, deleteFileLocal, uploadToDropbox, isDropboxConfigured, sanitizeFileName,
} from "@/lib/storage";

/**
 * Extension allowlist. The browser-supplied `file.type` is a claim, not a fact —
 * it can be empty (bypassing any type check) or wrong. The extension is what the
 * download route is told, and the download route is what sets Content-Type, so
 * the type we *trust* is derived here from the extension and nothing else.
 */
const EXTENSION_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function trustedMimeType(fileName: string, declared: string): string {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  const fromExtension = EXTENSION_MIME[ext];
  if (!fromExtension) {
    throw new ValidationError(
      `"${ext ? `.${ext}` : "No file extension"}" files are not supported. Allowed: ${Object.keys(EXTENSION_MIME).join(", ")}.`
    );
  }
  if (declared && ALLOWED.includes(declared) === false) {
    throw new ValidationError(`Unsupported file type "${declared}". Allowed: PDF, images, CSV, text, Word and Excel files.`);
  }
  return fromExtension;
}
import { ValidationError, optionalStr } from "@/lib/validate";
import { dropboxAccessTokenFor, deleteCredential } from "@/lib/integrations";
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
    // Type comes from the extension; the declared MIME is only cross-checked.
    const mimeType = trustedMimeType(file.name, file.type);
    const storedName = sanitizeFileName(file.name);

    const customerId = optionalStr(form.get("customer_id"), 60) || null;
    if (customerId && !get("select id from customers where id = ? and organization_id = ?", [customerId, orgId])) {
      throw new ValidationError("That customer does not belong to this workspace.");
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const stored = await saveFileLocal(storedName, bytes);
    let provider: "local" | "dropbox" = stored.provider;
    let storagePath = stored.path;
    let dropboxNote = "";

    // Order of preference: the workspace's own OAuth connection, then a
    // deployment-wide token (single-tenant self-hosting). Otherwise stay local.
    const workspaceToken = await dropboxAccessTokenFor(orgId);
    const token = workspaceToken ?? (process.env.DROPBOX_ACCESS_TOKEN ?? "").trim();
    if (isDropboxConfigured() && token) {
      // A sanitized single segment: a hostile name cannot write outside this
      // workspace's own folder in Dropbox.
      const result = await uploadToDropbox(token, `/${orgId}/${storedName}`, bytes);
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
      [id, orgId, customerId, user.id, file.name.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 200),
       mimeType, file.size, provider, storagePath, "ready", nowIso()]
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

/**
 * Disconnect this workspace's Dropbox.
 *
 * Connecting was possible but disconnecting was not: the token stayed in the
 * database with no way to revoke it from the app. Files already stored in Dropbox
 * keep their `storage_provider = dropbox` rows, so they remain listed; this only
 * removes our access, and the page tells the user that.
 */
export async function disconnectDropboxAction(): Promise<void> {
  try {
    await requirePermission("settings:workspace");
  } catch {
    forbiddenRedirect("settings:workspace");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  deleteCredential(orgId, "dropbox");
  audit({
    organizationId: orgId, actorId: user.id, action: "integration.dropbox_disconnected",
    targetType: "organization", targetId: orgId, metadata: { provider: "dropbox" },
  });
  logActivity({
    organizationId: orgId, actorId: user.id, entityType: "organization", entityId: orgId,
    action: "integration.dropbox_disconnected", summary: "Disconnected Dropbox for this workspace",
  });
  revalidatePath("/documents");
  redirect("/documents?dropbox=disconnected");
}
