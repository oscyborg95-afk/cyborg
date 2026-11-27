"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One optional photo per welcome box. Photos are shrunk in the browser before
// upload (a phone camera shot is 3–6 MB; WhatsApp shows ~1280px anyway), then
// stored in Supabase Storage — never in the database.

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
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not shrink the photo"))), "image/jpeg", JPEG_QUALITY)
  );
}

export interface WelcomePhotosState {
  configured: boolean | null;
  urls: Record<number, string | null | undefined>;
  busySlot: number | null;
  error: string;
  upload: (slot: number, file: File) => Promise<void>;
  remove: (slot: number) => Promise<void>;
}

export function useWelcomePhotos(): WelcomePhotosState {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [urls, setUrls] = useState<Record<number, string | null | undefined>>({});
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/welcome/photos")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setConfigured(Boolean(data.configured));
        const next: Record<number, string | null> = {};
        for (const p of data.photos ?? []) next[p.slot] = p.url ?? null;
        setUrls(next);
      })
      .catch(() => !cancelled && setConfigured(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = useCallback(async (slot: number, file: File) => {
    setBusySlot(slot);
    setError("");
    try {
      const small = await shrinkPhoto(file);
      const form = new FormData();
      form.set("slot", String(slot));
      form.set("file", small, "welcome.jpg");
      const res = await fetch("/api/welcome/photos", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Photo upload failed");
      setUrls((prev) => ({ ...prev, [slot]: data.url ?? null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setBusySlot(null);
    }
  }, []);

  const remove = useCallback(async (slot: number) => {
    setBusySlot(slot);
    setError("");
    try {
      const res = await fetch(`/api/welcome/photos?slot=${slot}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Removing the photo failed");
      setUrls((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Removing the photo failed");
    } finally {
      setBusySlot(null);
    }
  }, []);

  return { configured, urls, busySlot, error, upload, remove };
}

export function WelcomePhotoPicker({ slot, state }: { slot: number; state: WelcomePhotosState }) {
  const input = useRef<HTMLInputElement>(null);
  const has = slot in state.urls;
  const url = state.urls[slot];
  const busy = state.busySlot === slot;

  if (state.configured === false) {
    return (
      <p className="mt-2 font-display text-[11px] font-bold text-ink-soft">
        📷 Photos need Supabase Storage — add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the app&rsquo;s settings.
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {has && (
        <div className="relative h-16 w-16 overflow-hidden rounded-lg border-2 border-cardline bg-surface">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage link
            <img src={url} alt="Welcome photo" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-2xl">📷</span>
          )}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void state.upload(slot, file);
        }}
      />
      <button
        type="button"
        disabled={busy || state.configured === null}
        onClick={() => input.current?.click()}
        className="min-h-11 rounded-lg border-2 border-cardline bg-surface px-3 font-display text-sm font-bold text-ink hover:border-frog disabled:opacity-50 sm:min-h-0 sm:py-1 sm:text-xs"
      >
        {busy ? "Working…" : has ? "📷 Change photo" : "📷 Add photo"}
      </button>
      {has && !busy && (
        <button
          type="button"
          onClick={() => void state.remove(slot)}
          className="min-h-11 rounded-lg px-3 font-display text-sm font-bold text-flame-dark hover:bg-flame-tint sm:min-h-0 sm:py-1 sm:text-xs"
        >
          Remove
        </button>
      )}
      {has && (
        <span className="font-display text-[11px] font-bold text-ink-soft">
          Sent with this box&rsquo;s text as its caption.
        </span>
      )}
    </div>
  );
}
