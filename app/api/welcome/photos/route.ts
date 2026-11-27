import { NextRequest, NextResponse } from "next/server";
import { StorageNotConfiguredError, putObject, storageConfigured } from "@/lib/storage";
import { requireTenantSession } from "@/lib/tenant-context";
import { addWelcomeMedia, listWelcomeMedia, moveWelcomeMedia, removeWelcomeMedia } from "@/lib/welcome";
import { WELCOME_PHOTO_MAX_BYTES, WELCOME_PHOTOS_PER_BOX, WELCOME_SLOTS } from "@/lib/welcome-policy";

export const dynamic = "force-dynamic";

// The photo albums of the welcome boxes. Files go to Oracle Object Storage;
// the database only remembers their names and order. Previews are served by
// /api/welcome/photos/[id], so the secret storage link never reaches a browser.

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

export async function GET() {
  try {
    const media = await listWelcomeMedia();
    return NextResponse.json({
      configured: storageConfigured(),
      media: media.map((m) => ({ id: m.id, slot: m.slot, position: m.position })),
    });
  } catch (err) {
    return errorResponse(err, "Failed to load welcome photos");
  }
}

// multipart/form-data: slot, file — appends one photo to that box's album.
export async function POST(req: NextRequest) {
  try {
    if (!storageConfigured()) throw new StorageNotConfiguredError();
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
    const inBox = (await listWelcomeMedia()).filter((m) => m.slot === slot).length;
    if (inBox >= WELCOME_PHOTOS_PER_BOX) {
      return NextResponse.json({ error: `A box holds at most ${WELCOME_PHOTOS_PER_BOX} photos` }, { status: 400 });
    }

    const { tenantId } = await requireTenantSession();
    // A new name on every upload: the worker caches photos by name, so a
    // replaced photo can never be served from a stale cache.
    const objectName = `${tenantId}/welcome/${slot}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await putObject(objectName, new Uint8Array(await file.arrayBuffer()), file.type);
    const media = await addWelcomeMedia({ slot, object_name: objectName, mime: file.type });
    if (!media) {
      return NextResponse.json({ error: `A box holds at most ${WELCOME_PHOTOS_PER_BOX} photos` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, media: { id: media.id, slot: media.slot, position: media.position } });
  } catch (err) {
    return errorResponse(err, "Photo upload failed");
  }
}

// { id, direction: -1 | 1 } — move a photo earlier or later in its album.
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const direction = body?.direction === -1 ? -1 : body?.direction === 1 ? 1 : 0;
  if (!id || !direction) return NextResponse.json({ error: "id and direction required" }, { status: 400 });
  try {
    await moveWelcomeMedia(id, direction);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Reordering failed");
  }
}

// Removes the photo from the welcome. The storage link cannot delete, so the
// file itself stays in the private bucket (a few hundred KB, never sent again).
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    await removeWelcomeMedia(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Removing the photo failed");
  }
}
