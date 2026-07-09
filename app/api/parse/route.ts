import { NextRequest, NextResponse } from "next/server";
import { parseRawAddress, type MediaAttachment } from "@/lib/parse";
import { shippingFeeFor } from "@/lib/districts";
import { fetchWaMedia } from "@/lib/wa";
import { getSettings } from "@/lib/db";

// Parse delivery details out of chat text, and optionally out of voice notes /
// photos: media_ids are WhatsApp message ids whose bytes the worker captured.
// A media id that can't be fetched (mock mode, pruned, never downloaded) is
// skipped — the text still parses.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const raw_text = typeof body.raw_text === "string" ? body.raw_text : "";
  const mediaIds: string[] = Array.isArray(body.media_ids)
    ? body.media_ids.filter((id: unknown): id is string => typeof id === "string").slice(0, 3)
    : [];

  if (!raw_text.trim() && mediaIds.length === 0) {
    return NextResponse.json({ error: "raw_text is required" }, { status: 400 });
  }

  const media: MediaAttachment[] = (
    await Promise.all(mediaIds.map((id) => fetchWaMedia(id).catch(() => null)))
  ).filter((m): m is MediaAttachment => m !== null);

  // The operator's Gemini key(s) live in Settings; fall back to the env var
  // inside parseRawAddress when none is configured.
  const settings = await getSettings().catch(() => null);

  try {
    const parsed = await parseRawAddress(raw_text, media, {
      geminiApiKey: settings?.gemini_api_key,
    });
    return NextResponse.json({
      ...parsed,
      shipping_fee: shippingFeeFor(parsed.district),
      media_used: media.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parsing failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
