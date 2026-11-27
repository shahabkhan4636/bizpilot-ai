import fs from "node:fs/promises";
import path from "node:path";
import { newId } from "./ids";

/**
 * File storage abstraction.
 *  - local   : writes under data/uploads (works with zero credentials)
 *  - dropbox : real Dropbox API upload when an access token is provided
 *
 * We never ship partial/fake Dropbox support: if no token is present the app
 * reports storage_provider = 'local' in the database and shows Dropbox as
 * "not connected" in the UI.
 */

export type StorageProvider = "local" | "dropbox";

export function isDropboxConfigured(): boolean {
  return (process.env.DROPBOX_APP_KEY ?? "").trim().length > 0 && (process.env.DROPBOX_APP_SECRET ?? "").trim().length > 0;
}


const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

/**
 * Turns a client-supplied file name into a single safe path segment.
 *
 * A browser sends whatever the file was called. Anything outside a conservative
 * allowlist becomes "_", dot runs are collapsed, and the result is guaranteed to
 * be one segment — so it can never be used to address a path outside the folder
 * it is joined to (locally, or inside the workspace's Dropbox directory).
 */
export function sanitizeFileName(fileName: string): string {
  const segment = path.basename(String(fileName ?? "").replace(/\\/g, "/"));
  const safe = segment
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._]+/, "_")
    .slice(0, 120);
  return safe.length > 0 ? safe : "file";
}

export async function saveFileLocal(fileName: string, bytes: Buffer): Promise<{ path: string; provider: StorageProvider }> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const storagePath = `${newId()}-${sanitizeFileName(fileName)}`;
  await fs.writeFile(path.join(UPLOAD_DIR, storagePath), bytes);
  return { path: storagePath, provider: "local" };
}

export async function readFileLocal(storagePath: string): Promise<Buffer> {
  const resolved = path.join(UPLOAD_DIR, path.basename(storagePath));
  return fs.readFile(resolved);
}

export async function deleteFileLocal(storagePath: string): Promise<void> {
  try {
    await fs.unlink(path.join(UPLOAD_DIR, path.basename(storagePath)));
  } catch {
    /* already gone */
  }
}

export async function uploadToDropbox(accessToken: string, dropboxPath: string, bytes: Buffer): Promise<{ ok: boolean; path?: string; message?: string }> {
  try {
    const uploadUrl = (process.env.DROPBOX_CONTENT_URL ?? "https://content.dropboxapi.com/2/files/upload").trim();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath, mode: "add", autorename: true, mute: false }),
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `Dropbox ${res.status}: ${detail.slice(0, 200)}` };
    }
    const data = (await res.json()) as { path_display?: string };
    return { ok: true, path: data.path_display ?? dropboxPath };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Dropbox upload failed" };
  }
}

/**
 * Downloads a file from Dropbox (content API). Used by the download route; the
 * endpoint is overridable so tests and self-hosted proxies use the same path.
 */
export async function downloadFromDropbox(
  accessToken: string,
  dropboxPath: string
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
  const url = (process.env.DROPBOX_DOWNLOAD_URL ?? "https://content.dropboxapi.com/2/files/download").trim();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `Dropbox ${res.status}: ${detail.slice(0, 200)}` };
    }
    const buffer = await res.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buffer) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Dropbox download failed" };
  }
}
