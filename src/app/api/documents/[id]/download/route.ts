import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { get } from "@/lib/db";
import { readFileLocal, downloadFromDropbox } from "@/lib/storage";
import { dropboxAccessTokenFor } from "@/lib/integrations";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * Secure document download.
 *
 * Until now documents could be uploaded and listed but never opened — the file
 * existed and was unreachable. This route is the only way to read one:
 *
 *  - the caller must be signed in, and the document must belong to *their*
 *    organisation (a wrong id is a 404, not a 403 — a 403 would confirm that some
 *    other tenant's document exists);
 *  - the storage path is never taken from the request, only from the row, so no
 *    path traversal or arbitrary file read is possible;
 *  - local files are re-read by basename inside the upload directory (see
 *    `readFileLocal`) as a second layer;
 *  - every download is audited.
 */
export const dynamic = "force-dynamic";

/** RFC 6266/5987 filename so non-ASCII names survive the header. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  let ctx;
  try {
    ctx = await requireAuth();
  } catch {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!can(ctx.membership.role, "document:read")) {
    return NextResponse.json({ error: "You do not have permission to read documents." }, { status: 403 });
  }

  const { id } = await context.params;
  const document = get<{
    id: string;
    file_name: string;
    mime_type: string | null;
    storage_provider: string;
    storage_path: string;
  }>(
    `select id, file_name, mime_type, storage_provider, storage_path
       from documents where id = ? and organization_id = ?`,
    [id, ctx.membership.organization_id]
  );
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let bytes: Uint8Array | null = null;
  if (document.storage_provider === "dropbox") {
    const token =
      (await dropboxAccessTokenFor(ctx.membership.organization_id)) ??
      (process.env.DROPBOX_ACCESS_TOKEN ?? "").trim();
    if (!token) {
      return NextResponse.json(
        { error: "This file lives in Dropbox but this workspace has no Dropbox connection." },
        { status: 409 }
      );
    }
    const remote = await downloadFromDropbox(token, document.storage_path);
    if (!remote.ok) {
      logger.error("dropbox download failed", { documentId: document.id, error: remote.message });
      return NextResponse.json({ error: `Dropbox download failed: ${remote.message}` }, { status: 502 });
    }
    bytes = remote.bytes;
  } else {
    try {
      bytes = await readFileLocal(document.storage_path);
    } catch {
      // The row exists but the file is gone (volume wiped, moved). Say so instead
      // of returning an empty 200 that looks like a zero-byte document.
      return NextResponse.json(
        { error: "The stored file is missing on this server. Upload it again." },
        { status: 410 }
      );
    }
  }

  audit({
    organizationId: ctx.membership.organization_id,
    actorId: ctx.user.id,
    action: "document.download",
    targetType: "document",
    targetId: document.id,
    metadata: { provider: document.storage_provider },
  });

  // BodyInit wants an ArrayBuffer view backed by a plain ArrayBuffer.
  const body = new Uint8Array(bytes);
  return new NextResponse(body.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": document.mime_type || "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": contentDisposition(document.file_name),
      // Never let a browser sniff or inline-render an uploaded file.
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
