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

export function defaultProvider(): StorageProvider {
  return "local";
}

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

export async function saveFileLocal(fileName: string, bytes: Buffer): Promise<{ path: string; provider: StorageProvider }> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const storagePath = `${newId()}-${safeName}`;
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
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
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
