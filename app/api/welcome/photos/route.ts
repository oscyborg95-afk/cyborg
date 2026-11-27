import { NextRequest, NextResponse } from "next/server";
import {
  StorageNotConfiguredError,
  deleteObject,
  signedObjectUrl,
  storageConfigured,
  uploadObject,
} from "@/lib/storage";
import { requireTenantSession } from "@/lib/tenant-context";
import {
  WELCOME_MEDIA_BUCKET,
  clearWelcomePhoto,
  listWelcomePhotos,
  setWelcomePhoto,
} from "@/lib/welcome";
import { WELCOME_PHOTO_MAX_BYTES, WELCOME_SLOTS } from "@/lib/welcome-policy";

export const dynamic = "force-dynamic";

// One optional photo per welcome box. The file goes to Supabase Storage; the
// database only remembers its name.

const MIME_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function slotFrom(value: unknown): number | null {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 0 && slot < WELCOME_SLOTS ? slot : null;
}

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof StorageNotConfiguredError) {
    return NextResponse.json({ error: err.message, notConfigured: true }, { status: 503 });
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : fallback }, { status: 500 });
}

// Slots with a short-lived preview link each (only the owner views this page).
export async function GET() {
  try {
    const photos = await listWelcomePhotos();
    if (!storageConfigured()) {
      return NextResponse.json({ configured: false, photos: photos.map((p) => ({ slot: p.slot, url: null })) });
    }
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        slot: p.slot,
        url: await signedObjectUrl(WELCOME_MEDIA_BUCKET, p.path, 600).catch(() => null),
      }))
    );
    return NextResponse.json({ configured: true, photos: withUrls });
  } catch (err) {
    return errorResponse(err, "Failed to load welcome photos");
  }
}

// multipart/form-data: slot, file
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const slot = slotFrom(form.get("slot"));
    const file = form.get("file");
    if (slot === null) return NextResponse.json({ error: "Unknown welcome box" }, { status: 400 });
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: "Choose a photo" }, { status: 400 });
    }
    const ext = MIME_EXT[file.type];
    if (!ext) return NextResponse.json({ error: "Use a JPG, PNG or WebP photo" }, { status: 400 });
    if (file.size > WELCOME_PHOTO_MAX_BYTES) {
      return NextResponse.json({ error: "Photo is too large (max 2 MB after shrinking)" }, { status: 400 });
    }

    const { tenantId } = await requireTenantSession();
    // A new name on every upload: the worker caches photos by name, so a
    // replaced photo can never be served from a stale cache.
    const path = `${tenantId}/welcome-${slot}-${Date.now()}.${ext}`;
    await uploadObject(WELCOME_MEDIA_BUCKET, path, new Uint8Array(await file.arrayBuffer()), file.type);
    const old = await setWelcomePhoto({ slot, path, mime: file.type });
    if (old && old.path !== path) await deleteObject(WELCOME_MEDIA_BUCKET, old.path).catch(() => null);

    const url = await signedObjectUrl(WELCOME_MEDIA_BUCKET, path, 600).catch(() => null);
    return NextResponse.json({ ok: true, slot, url });
  } catch (err) {
    return errorResponse(err, "Photo upload failed");
  }
}

export async function DELETE(req: NextRequest) {
  const slot = slotFrom(req.nextUrl.searchParams.get("slot"));
  if (slot === null) return NextResponse.json({ error: "Unknown welcome box" }, { status: 400 });
  try {
    const old = await clearWelcomePhoto(slot);
    if (old && storageConfigured()) await deleteObject(WELCOME_MEDIA_BUCKET, old.path).catch(() => null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Removing the photo failed");
  }
}
