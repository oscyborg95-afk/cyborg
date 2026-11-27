"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WELCOME_PHOTOS_PER_BOX, WELCOME_PHOTOS_TOTAL } from "@/lib/welcome-policy";

// A photo album per welcome box. WhatsApp shows photos sent back to back as
// one swipeable grid, so a box's album arrives the way a carousel does from
// the phone. Photos are shrunk in the browser first (a camera shot is 3–6 MB;
// WhatsApp shows ~1280px anyway), then stored in Oracle Object Storage —
// never in the database.

const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.82;

async function shrinkPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't prepare the photo");
  // JPEG has no transparency; paint white behind PNG cut-outs.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not shrink the photo"))),
      "image/jpeg",
      JPEG_QUALITY
    )
  );
}

interface MediaItem {
  id: string;
  slot: number;
  position: number;
}

export interface WelcomePhotosState {
  configured: boolean | null;
  media: MediaItem[];
  busySlot: number | null;
  error: string;
  upload: (slot: number, files: File[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  move: (id: string, direction: -1 | 1) => Promise<void>;
}

export function useWelcomePhotos(): WelcomePhotosState {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const res = await fetch("/api/welcome/photos", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to load welcome photos");
    setConfigured(Boolean(data.configured));
    setMedia(data.media ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/welcome/photos", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setConfigured(Boolean(data.configured));
        setMedia(data.media ?? []);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One at a time, in the order picked — that order is the album order.
  const upload = useCallback(
    async (slot: number, files: File[]) => {
      setBusySlot(slot);
      setError("");
      try {
        for (const file of files) {
          const small = await shrinkPhoto(file);
          const form = new FormData();
          form.set("slot", String(slot));
          form.set("file", small, "welcome.jpg");
          const res = await fetch("/api/welcome/photos", { method: "POST", body: form });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Photo upload failed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Photo upload failed");
      } finally {
        await reload().catch(() => null);
        setBusySlot(null);
      }
    },
    [reload]
  );

  const act = useCallback(
    async (slot: number, request: () => Promise<Response>, failure: string) => {
      setBusySlot(slot);
      setError("");
      try {
        const res = await request();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || failure);
      } catch (err) {
        setError(err instanceof Error ? err.message : failure);
      } finally {
        await reload().catch(() => null);
        setBusySlot(null);
      }
    },
    [reload]
  );

  const remove = useCallback(
    (id: string) =>
      act(
        media.find((m) => m.id === id)?.slot ?? -1,
        () => fetch(`/api/welcome/photos?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
        "Removing the photo failed"
      ),
    [act, media]
  );

  const move = useCallback(
    (id: string, direction: -1 | 1) =>
      act(
        media.find((m) => m.id === id)?.slot ?? -1,
        () =>
          fetch("/api/welcome/photos", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, direction }),
          }),
        "Reordering failed"
      ),
    [act, media]
  );

  return { configured, media, busySlot, error, upload, remove, move };
}

const smallButton =
  "flex h-7 w-7 items-center justify-center rounded-md bg-surface/90 font-display text-xs font-extrabold text-ink shadow disabled:opacity-30";

export function WelcomePhotoPicker({ slot, state }: { slot: number; state: WelcomePhotosState }) {
  const input = useRef<HTMLInputElement>(null);
  const album = state.media.filter((m) => m.slot === slot);
  const busy = state.busySlot === slot;
  const room = WELCOME_PHOTOS_PER_BOX - album.length;
  const totalUsed = state.media.length;

  if (state.configured === false) {
    return (
      <p className="mt-2 font-display text-[11px] font-bold text-ink-soft">
        📷 Photos need storage — add OCI_MEDIA_PAR_URL to the app&rsquo;s environment variables.
      </p>
    );
  }

  return (
    <div className="mt-2">
      {album.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {album.map((m, i) => (
            <div
              key={m.id}
              className="relative h-20 w-20 overflow-hidden rounded-lg border-2 border-cardline bg-surface"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- private preview served by our own route */}
              <img src={`/api/welcome/photos/${m.id}`} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
              <span className="absolute left-1 top-1 rounded bg-ink/70 px-1 font-display text-[10px] font-extrabold text-white">
                {i + 1}
              </span>
              <div className="absolute inset-x-1 bottom-1 flex justify-between gap-1">
                <button
                  type="button"
                  aria-label="Move earlier"
                  disabled={busy || i === 0}
                  onClick={() => void state.move(m.id, -1)}
                  className={smallButton}
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="Remove photo"
                  disabled={busy}
                  onClick={() => void state.remove(m.id)}
                  className={`${smallButton} text-flame-dark`}
                >
                  ✕
                </button>
                <button
                  type="button"
                  aria-label="Move later"
                  disabled={busy || i === album.length - 1}
                  onClick={() => void state.move(m.id, 1)}
                  className={smallButton}
                >
                  ›
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].slice(0, Math.max(0, room));
          e.target.value = "";
          if (files.length) void state.upload(slot, files);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || state.configured === null || room <= 0}
          onClick={() => input.current?.click()}
          className="min-h-11 rounded-lg border-2 border-cardline bg-surface px-3 font-display text-sm font-bold text-ink hover:border-frog disabled:opacity-50 sm:min-h-0 sm:py-1 sm:text-xs"
        >
          {busy ? "Working…" : album.length ? "📷 Add more photos" : "📷 Add photos"}
        </button>
        <span className="font-display text-[11px] font-bold text-ink-soft">
          {album.length > 0
            ? `${album.length}/${WELCOME_PHOTOS_PER_BOX} — sent as one album; this box's text is the first photo's caption.`
            : `Up to ${WELCOME_PHOTOS_PER_BOX} photos, sent as one album.`}
          {totalUsed > WELCOME_PHOTOS_TOTAL &&
            ` Only the first ${WELCOME_PHOTOS_TOTAL} photos of the whole welcome are sent.`}
        </span>
      </div>
    </div>
  );
}
