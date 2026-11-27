import { NextRequest, NextResponse } from "next/server";
import { getObject } from "@/lib/storage";
import { getWelcomeMedia } from "@/lib/welcome";

export const dynamic = "force-dynamic";

// Preview of one welcome photo for the settings page, streamed from Oracle
// Object Storage so the secret storage link stays on the server. Each upload
// has its own id, so the browser may cache it for good.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const media = await getWelcomeMedia(id);
    if (!media) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
    const res = await getObject(media.object_name);
    return new NextResponse(res.body, {
      headers: {
        "Content-Type": media.mime,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Photo unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
