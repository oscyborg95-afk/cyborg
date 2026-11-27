// Supabase Storage over its REST API — for files that must never live in the
// database (the 500 MB free DB cap filled with photos once, Nov 2026).
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, server-side only. Without
// them every call throws StorageNotConfiguredError and callers degrade
// (welcome photos are simply not sent).

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Photo storage is not set up — add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
}

function config(): { base: string; key: string } {
  const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key || base.includes("your-project")) throw new StorageNotConfiguredError();
  return { base: `${base}/storage/v1`, key };
}

export function storageConfigured(): boolean {
  try {
    config();
    return true;
  } catch {
    return false;
  }
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function fail(res: Response, what: string): Promise<never> {
  const detail = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(`${what} failed (${res.status}) ${detail}`.trim());
}

const readyBuckets = new Set<string>();

// Private bucket, created on first use. "Already exists" is success.
async function ensureBucket(bucket: string): Promise<void> {
  if (readyBuckets.has(bucket)) return;
  const { base, key } = config();
  const res = await fetch(`${base}/bucket`, {
    method: "POST",
    headers: headers(key, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: false,
      file_size_limit: 6 * 1024 * 1024,
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp"],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (!/already exists|Duplicate/i.test(text)) {
      throw new Error(`Creating storage bucket failed (${res.status}) ${text.slice(0, 200)}`);
    }
  }
  readyBuckets.add(bucket);
}

export async function uploadObject(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string
): Promise<void> {
  await ensureBucket(bucket);
  const { base, key } = config();
  const res = await fetch(`${base}/object/${bucket}/${encodePath(path)}`, {
    method: "POST",
    headers: headers(key, { "Content-Type": contentType, "x-upsert": "true" }),
    body: Buffer.from(bytes),
  });
  if (!res.ok) await fail(res, "Photo upload");
}

export async function deleteObject(bucket: string, path: string): Promise<void> {
  const { base, key } = config();
  const res = await fetch(`${base}/object/${bucket}`, {
    method: "DELETE",
    headers: headers(key, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!res.ok && res.status !== 404) await fail(res, "Photo delete");
}

// A time-limited link to a private file. Whoever holds it can download the
// file until it expires, so keep the lifetime short.
export async function signedObjectUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string> {
  const { base, key } = config();
  const res = await fetch(`${base}/object/sign/${bucket}/${encodePath(path)}`, {
    method: "POST",
    headers: headers(key, { "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) await fail(res, "Photo link");
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const signed = data.signedURL || data.signedUrl;
  if (!signed) throw new Error("Photo link missing from storage response");
  return signed.startsWith("http") ? signed : `${base}${signed.startsWith("/") ? "" : "/"}${signed}`;
}
