// Oracle Cloud Object Storage (Always Free: 20 GB stored, 10 TB/month out) for
// files that must never live in the database — the Supabase DB cap filled with
// photos once (Nov 2026), and Supabase egress is a shared 5 GB a month.
//
// OCI_MEDIA_PAR_URL is a pre-authenticated request on the private bucket
// "welcome-media": a secret URL ending in /o/ that allows reading and writing
// objects (not listing or deleting). Server-side only — never send it to a
// browser; the settings page previews photos through /api/welcome/photos.

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Photo storage is not set up — add OCI_MEDIA_PAR_URL to the app's environment variables.");
  }
}

function base(): string {
  const url = (process.env.OCI_MEDIA_PAR_URL || "").trim();
  if (!/^https:\/\/objectstorage\.[a-z0-9-]+\.oraclecloud\.com\/p\/.+\/o\/$/.test(url)) {
    throw new StorageNotConfiguredError();
  }
  return url;
}

export function storageConfigured(): boolean {
  try {
    base();
    return true;
  } catch {
    return false;
  }
}

const encodeName = (name: string) => name.split("/").map(encodeURIComponent).join("/");

// The full download URL for one object. It carries the secret link, so it is
// only handed to the WhatsApp worker (server to server).
export function objectUrl(name: string): string {
  return `${base()}${encodeName(name)}`;
}

export async function putObject(name: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(objectUrl(name), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: Buffer.from(bytes),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Photo upload failed (${res.status}) ${detail}`.trim());
  }
}

export async function getObject(name: string): Promise<Response> {
  const res = await fetch(objectUrl(name), { cache: "no-store" });
  if (!res.ok) throw new Error(`Photo download failed (${res.status})`);
  return res;
}
