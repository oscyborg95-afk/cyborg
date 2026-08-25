"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AnnouncementAudience, AnnouncementRecipient } from "@/lib/announcements";
import { Froggy } from "../components/froggy";
import { Button, Card, ProgressBar } from "../components/ui";
import { fieldClass, timeAgo } from "../components/crm-ui";

// Compose screen for a one-off announcement to customers with a parcel in
// flight — the "couriers are shut for the holiday" message. Nothing here is
// automated: the operator picks who, writes the words, and watches it send.
//
// The send itself is queued server-side (see lib/announcements.ts); this page
// only paces the drain so WhatsApp sees a human cadence, not a burst.

const MIN_GAP_MS = 8_000;
const MAX_GAP_MS = 15_000;

const AUDIENCE_LABEL: Record<AnnouncementAudience, { title: string; blurb: string; icon: string }> = {
  booked: {
    icon: "🚚",
    title: "Booked",
    blurb: "Parcel is with the courier — these are the deliveries a holiday stalls.",
  },
  pending: {
    icon: "📦",
    title: "Confirmed, not shipped",
    blurb: "They said OK but the parcel has not been handed to the courier yet.",
  },
};

const PLACEHOLDERS = [
  { token: "{{name}}", hint: "First name" },
  { token: "{{order_no}}", hint: "Order ref" },
  { token: "{{tracking}}", hint: "Tracking no." },
  { token: "{{total}}", hint: "COD total" },
] as const;

interface Progress {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  waiting: number;
  last_error?: string;
  just_sent?: number;
  just_failed?: number;
}

// If WhatsApp is down, every send fails the same way. Give up after a few in a
// row rather than grinding through six retries per customer while the operator
// watches a progress bar that never moves.
const CONSECUTIVE_FAILURE_LIMIT = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mirrors renderAnnouncement in lib/announcements.ts so the preview is exactly
// what gets queued. Kept in sync by hand — both drop unresolved-placeholder
// lines the same way lib/templates.ts does.
function renderPreview(source: string, recipient: AnnouncementRecipient): string {
  const firstName = recipient.customer_name.trim().split(/\s+/)[0] ?? "";
  return source
    .replaceAll("{{name}}", firstName || "{{name}}")
    .replaceAll("{{order_no}}", recipient.order_nos.join(", ") || "{{order_no}}")
    .replaceAll("{{tracking}}", recipient.tracking_ids.join(", ") || "{{tracking}}")
    .replaceAll("{{total}}", String(recipient.total_cod))
    .split("\n")
    .filter((line) => !/\{\{(name|order_no|tracking|total)\}\}/.test(line))
    .join("\n");
}

// useSearchParams forces client-side rendering up to the nearest boundary, and
// a production build refuses to compile a static page without one.
export default function AnnouncementsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl p-4 sm:p-6">
          <p className="font-display text-sm font-bold text-ink-soft">⏳ Loading…</p>
        </main>
      }
    >
      <AnnouncementComposer />
    </Suspense>
  );
}

function AnnouncementComposer() {
  const searchParams = useSearchParams();
  const initialAudience: AnnouncementAudience[] =
    searchParams.get("audience") === "pending" ? ["pending"] : ["booked"];

  const [audiences, setAudiences] = useState<AnnouncementAudience[]>(initialAudience);
  const [recipients, setRecipients] = useState<AnnouncementRecipient[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [previewIndex, setPreviewIndex] = useState(0);
  // Computed when the audience loads, not during render: "recent" is a clock
  // reading, and a re-render must not silently change who is flagged.
  const [recentKeys, setRecentKeys] = useState<Set<string>>(new Set());
  const [maxPerBatch, setMaxPerBatch] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Kept apart from `error`: the audience reload that follows a send clears the
  // load error, and it must not take the reason the send stopped with it.
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState("");
  const stopRef = useRef(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (wanted: AnnouncementAudience[]) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/announcements?audience=${wanted.join(",")}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the audience");
      const rows = data.recipients as AnnouncementRecipient[];
      setRecipients(rows);
      setMaxPerBatch(data.max_per_batch ?? 100);
      // Everyone is ticked by default — on a holiday you genuinely do want the
      // whole list — except anyone we messaged in the last few hours.
      const cutoff = Date.now() - (data.recent_contact_hours ?? 6) * 3_600_000;
      const recent = new Set(
        rows
          .filter((r) => r.last_message_at && new Date(r.last_message_at).getTime() > cutoff)
          .map((r) => r.phone_key)
      );
      setRecentKeys(recent);
      setSelected(new Set(rows.filter((r) => !recent.has(r.phone_key)).map((r) => r.phone_key)));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the audience");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(audiences);
  }, [load, audiences]);

  function toggleAudience(value: AnnouncementAudience) {
    if (sending) return;
    setAudiences((current) =>
      current.includes(value)
        ? current.length === 1
          ? current // never leave the audience empty
          : current.filter((item) => item !== value)
        : [...current, value]
    );
  }

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return recipients;
    return recipients.filter((r) =>
      [r.customer_name, r.phone_number, r.city, r.district, ...r.order_nos, ...r.tracking_ids]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [recipients, search]);

  const chosen = useMemo(
    () => recipients.filter((r) => selected.has(r.phone_key)),
    [recipients, selected]
  );
  const overCap = chosen.length > maxPerBatch;
  // Every placeholder on a line unresolved means the line is dropped — which
  // can silently empty the whole message for customers with no waybill yet.
  const blankFor = useMemo(
    () => (message.trim() ? chosen.filter((r) => !renderPreview(message, r).trim()) : []),
    [message, chosen]
  );
  const previewFor = chosen[Math.min(previewIndex, Math.max(chosen.length - 1, 0))];

  function toggleOne(key: string) {
    if (sending) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setAllVisible(checked: boolean) {
    if (sending) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const r of visible) {
        if (checked) next.add(r.phone_key);
        else next.delete(r.phone_key);
      }
      return next;
    });
  }

  function insertPlaceholder(token: string) {
    const field = messageRef.current;
    if (!field) {
      setMessage((current) => current + token);
      return;
    }
    const start = field.selectionStart ?? message.length;
    const end = field.selectionEnd ?? message.length;
    const next = message.slice(0, start) + token + message.slice(end);
    setMessage(next);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function send() {
    if (!message.trim() || chosen.length === 0 || sending || overCap || blankFor.length > 0) return;
    const minutes = Math.max(1, Math.round((chosen.length * 11.5) / 60));
    if (
      !confirm(
        `Send this message to ${chosen.length} customer${chosen.length === 1 ? "" : "s"}?\n\n` +
          `It goes out one at a time over about ${minutes} min. You can close the tab — ` +
          `anything left over is sent automatically later.`
      )
    )
      return;

    setSending(true);
    setDone("");
    setSendError("");
    stopRef.current = false;

    let batchId: string;
    try {
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: message,
          phone_keys: chosen.map((r) => r.phone_key),
          audiences,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The announcement could not be queued");
      batchId = data.batch_id;
      setProgress({ total: data.queued, sent: 0, failed: 0, skipped: 0, waiting: data.queued });
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "The announcement could not be queued");
      setSending(false);
      return;
    }

    let latest: Progress | null = null;
    let consecutiveFailures = 0;
    let stalled = false;
    while (!stopRef.current) {
      try {
        const res = await fetch("/api/announcements/drain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batch_id: batchId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "The send stalled");
        latest = data as Progress;
        setProgress(latest);
        if (latest.waiting === 0) break;
        consecutiveFailures = latest.just_sent ? 0 : consecutiveFailures + (latest.just_failed ?? 0);
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          stalled = true;
          setSendError(
            `WhatsApp is not accepting messages${latest.last_error ? ` — ${latest.last_error}` : ""}. ` +
              `Stopped after ${CONSECUTIVE_FAILURE_LIMIT} failures in a row; the rest stays queued.`
          );
          break;
        }
      } catch (cause) {
        setSendError(cause instanceof Error ? cause.message : "The send stalled");
        break;
      }
      await sleep(MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
    }

    setSending(false);
    const sent = latest?.sent ?? 0;
    const failed = latest?.failed ?? 0;
    const skipped = latest?.skipped ?? 0;
    const leftover = latest?.waiting ?? 0;
    setDone(
      (stopRef.current || stalled
        ? `⏹️ Stopped — ${sent} sent so far.`
        : `✅ Sent to ${sent} customer${sent === 1 ? "" : "s"}.`) +
        (failed ? ` ${failed} failed.` : "") +
        (skipped ? ` ${skipped} skipped (their parcel already moved).` : "") +
        (leftover ? ` ${leftover} still queued — they go out automatically.` : "")
    );
    void load(audiences);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 pb-28 sm:p-6 sm:pb-6">
      <header className="flex items-center gap-3">
        <Froggy mood={sending ? "thinking" : "happy"} size={56} />
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ink">Announcement</h1>
          <p className="font-display text-sm font-bold text-ink-soft">
            Tell customers with a parcel in flight about a holiday, a delay, or a courier strike
          </p>
        </div>
      </header>

      <Card className="!border-gold bg-gold/10 p-4">
        <p className="font-display text-xs font-bold text-ink">
          ⚠️ Nothing here sends by itself — you pick the customers and write the message. Sends are
          spaced 8–15 s apart and capped at {maxPerBatch} per batch, because WhatsApp bans numbers
          that blast. Anyone whose parcel is delivered or returned before their turn is skipped
          automatically.
        </p>
      </Card>

      {error && (
        <Card className="grid gap-3 !border-danger-line bg-danger-bg p-4 sm:flex sm:items-center sm:justify-between">
          <p role="alert" className="font-display text-sm font-bold text-danger-ink">
            ⚠️ {error}
          </p>
          <button
            type="button"
            onClick={() => void load(audiences)}
            className="min-h-11 rounded-xl border-2 border-danger-line px-4 py-2 font-display text-sm font-extrabold text-danger-ink focus:outline-none focus:ring-2 focus:ring-danger-ink"
          >
            Try again
          </button>
        </Card>
      )}

      {/* ---- Step 1 · who gets it ------------------------------------------ */}
      <Card className="space-y-4 p-4 sm:p-5">
        <h2 className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
          1 · Who gets it
        </h2>

        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(AUDIENCE_LABEL) as AnnouncementAudience[]).map((value) => {
            const active = audiences.includes(value);
            const meta = AUDIENCE_LABEL[value];
            return (
              <button
                key={value}
                type="button"
                onClick={() => toggleAudience(value)}
                disabled={sending}
                aria-pressed={active}
                className={`rounded-xl border-2 p-3 text-left transition disabled:opacity-60 ${
                  active
                    ? "border-grape bg-grape-tint text-grape-dark shadow-xs"
                    : "border-cardline bg-surface text-ink-soft hover:border-grape/50"
                }`}
              >
                <span className="block font-display text-sm font-extrabold">
                  {meta.icon} {meta.title}
                </span>
                <span className="mt-0.5 block font-display text-[11px] font-bold text-ink-soft">
                  {meta.blurb}
                </span>
              </button>
            );
          })}
        </div>

        <input
          className={fieldClass}
          placeholder="Search name, phone, city or tracking…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={sending}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="font-display text-sm font-extrabold text-ink">
            {loading
              ? "⏳ Loading the audience…"
              : `🎯 ${chosen.length} of ${recipients.length} selected`}
            {overCap && (
              <span className="text-danger-ink"> — over the {maxPerBatch} cap, untick some</span>
            )}
          </p>
          <div className="flex gap-2">
            <Button tone="ghost" className="text-xs" onClick={() => setAllVisible(true)} disabled={sending || loading}>
              Select all
            </Button>
            <Button tone="ghost" className="text-xs" onClick={() => setAllVisible(false)} disabled={sending || loading}>
              Clear
            </Button>
          </div>
        </div>

        {!loading && recipients.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-cardline bg-surface-soft p-6 text-center">
            <Froggy mood="sleepy" size={56} />
            <p className="font-display text-sm font-bold text-ink-soft">
              No open orders in this audience — nobody to tell.
            </p>
          </div>
        ) : (
          <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
            {visible.map((r) => {
              const recent = recentKeys.has(r.phone_key);
              return (
                <li key={r.phone_key}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-surface-soft p-3 transition hover:bg-cream/60">
                    <input
                      type="checkbox"
                      checked={selected.has(r.phone_key)}
                      onChange={() => toggleOne(r.phone_key)}
                      disabled={sending}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-frog)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-display text-sm font-extrabold text-ink">
                        {r.customer_name}
                        {r.order_ids.length > 1 && (
                          <span className="ml-1 rounded-lg bg-grape-tint px-1.5 py-0.5 font-display text-[10px] font-extrabold uppercase text-grape-dark">
                            {r.order_ids.length} parcels
                          </span>
                        )}
                      </span>
                      <span className="block break-words font-display text-[11px] font-bold text-ink-soft">
                        {[r.order_nos.join(", "), r.city, r.tracking_ids.join(", ")]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <span className="block font-display text-[11px] font-bold text-ink-soft">
                        Rs. {r.total_cod} · {timeAgo(r.booked_at)}
                        {recent && (
                          <span className="ml-1 text-flame-dark">
                            · ⚠️ messaged {timeAgo(r.last_message_at)}
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ---- Step 2 · the message ------------------------------------------ */}
      <Card className="space-y-4 p-4 sm:p-5">
        <h2 className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
          2 · What it says
        </h2>

        <textarea
          ref={messageRef}
          rows={8}
          className="min-h-44 w-full rounded-xl border-2 border-cardline bg-cream/60 p-3 text-base font-semibold text-ink outline-none focus:border-frog focus:ring-2 focus:ring-frog/20 sm:text-sm"
          placeholder={"හෙට සහ අනිද්දා නිවාඩු දින නිසා courier සේවා ක්‍රියාත්මක නොවේ 🙏\nඔබගේ order එක ({{order_no}}) ඊට පසු දිනයේ deliver කරනවා."}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
        />

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-[11px] font-extrabold uppercase text-ink-soft">
            Insert:
          </span>
          {PLACEHOLDERS.map((p) => (
            <button
              key={p.token}
              type="button"
              onClick={() => insertPlaceholder(p.token)}
              disabled={sending}
              title={p.hint}
              className="min-h-9 rounded-lg border-2 border-cardline bg-surface px-2 py-1 font-display text-[11px] font-extrabold text-ink-soft transition hover:border-frog hover:text-frog-dark disabled:opacity-60"
            >
              {p.token}
            </button>
          ))}
          <span className="ml-auto font-display text-[11px] font-bold text-ink-soft">
            {message.length} characters
          </span>
        </div>

        {blankFor.length > 0 && (
          <p
            role="alert"
            className="rounded-xl border-2 border-danger-line bg-danger-bg p-3 font-display text-xs font-bold text-danger-ink"
          >
            ⚠️ This comes out blank for {blankFor.length} customer
            {blankFor.length === 1 ? "" : "s"} ({blankFor.slice(0, 3).map((r) => r.customer_name).join(", ")}
            {blankFor.length > 3 ? "…" : ""}). A line disappears when every placeholder on it is
            unresolved — put {"{{tracking}}"} on its own line, or untick those customers.
          </p>
        )}

        {message.trim() && previewFor && (
          <div className="rounded-xl border-2 border-cardline bg-surface-soft p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-display text-[11px] font-extrabold uppercase text-ink-soft">
                Preview · {previewFor.customer_name}
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous recipient"
                  onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
                  disabled={previewIndex === 0}
                  className="min-h-9 rounded-lg border-2 border-cardline bg-surface px-2 font-display text-xs font-extrabold text-ink-soft disabled:opacity-40"
                >
                  ‹
                </button>
                <span className="font-display text-[11px] font-bold text-ink-soft">
                  {Math.min(previewIndex + 1, chosen.length)}/{chosen.length}
                </span>
                <button
                  type="button"
                  aria-label="Next recipient"
                  onClick={() => setPreviewIndex((i) => Math.min(chosen.length - 1, i + 1))}
                  disabled={previewIndex >= chosen.length - 1}
                  className="min-h-9 rounded-lg border-2 border-cardline bg-surface px-2 font-display text-xs font-extrabold text-ink-soft disabled:opacity-40"
                >
                  ›
                </button>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-wrap rounded-xl bg-pond p-3 font-display text-sm font-semibold text-ink">
              {renderPreview(message, previewFor)}
            </p>
          </div>
        )}
      </Card>

      {/* ---- Step 3 · send ------------------------------------------------- */}
      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
          3 · Send
        </h2>

        {sending && progress ? (
          <div className="space-y-2">
            <ProgressBar
              value={((progress.sent + progress.failed + progress.skipped) / Math.max(progress.total, 1)) * 100}
              tone="var(--color-frog)"
            />
            <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
              <p role="status" className="font-display text-sm font-bold text-ink">
                📨 {progress.sent + progress.failed + progress.skipped}/{progress.total} —{" "}
                {progress.waiting} to go…
              </p>
              <Button
                className="w-full sm:w-auto"
                tone="ghost"
                onClick={() => (stopRef.current = true)}
              >
                ⏹️ Stop
              </Button>
            </div>
            <p className="font-display text-xs font-bold text-ink-soft">
              Safe to close this tab — whatever is left goes out on the next automatic sweep.
            </p>
          </div>
        ) : (
          <Button
            tone="frog"
            onClick={send}
            disabled={
              loading ||
              sending ||
              overCap ||
              blankFor.length > 0 ||
              !message.trim() ||
              chosen.length === 0
            }
            className="min-h-12 w-full !py-3"
          >
            📣 Send to {chosen.length} customer{chosen.length === 1 ? "" : "s"}
          </Button>
        )}

        {sendError && (
          <p
            role="alert"
            className="rounded-xl border-2 border-danger-line bg-danger-bg p-3 font-display text-xs font-bold text-danger-ink"
          >
            ⚠️ {sendError}
          </p>
        )}

        {done && (
          <p className="animate-pop rounded-xl border-2 border-frog bg-pond p-2.5 font-display text-xs font-bold text-frog-dark">
            {done}
          </p>
        )}
      </Card>
    </main>
  );
}
