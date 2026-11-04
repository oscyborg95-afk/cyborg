"use client";

// Cancel a pending or booked order — the customer called it off after dispatch,
// or a duplicate slipped through. Shared by the Orders page and the invoice
// printer so both record the same reason and follow the same rules.

import { useEffect, useRef, useState } from "react";
import type { Order } from "@/lib/types";
import { Button } from "./ui";

const REASONS = [
  "Customer cancelled",
  "Duplicate order",
  "Wrong details — will re-create",
  "Out of stock",
] as const;

export function CancelOrderDialog({
  order,
  trackingId,
  courierName,
  defaultReason = REASONS[0],
  onClose,
  onCancelled,
}: {
  order: Pick<Order, "id" | "order_no" | "customer_name" | "total_cod" | "order_status">;
  trackingId?: string | null;
  courierName?: string | null;
  defaultReason?: string;
  onClose: () => void;
  onCancelled: (order: Order) => void;
}) {
  const [reason, setReason] = useState(defaultReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Cancel failed");
      onCancelled(data.order as Order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
      setBusy(false);
    }
  }

  const ref = order.order_no ? `${order.order_no} · ` : "";
  return (
    <div
      className="print-hide fixed inset-0 z-[60] flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-order-title"
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-[2rem] border-2 border-cardline bg-surface p-5 shadow-2xl sm:rounded-[2rem]"
      >
        <p className="font-display text-xs font-extrabold uppercase tracking-wider text-flame-dark">Cancel order</p>
        <h2 id="cancel-order-title" className="font-display text-xl font-extrabold text-ink">
          {ref}
          {order.customer_name}
        </h2>
        <p className="mt-1 text-sm font-bold text-ink-soft">
          Rs. {Math.round(Number(order.total_cod)).toLocaleString("en-LK")}
          {trackingId ? ` · ${courierName ? `${courierName} ` : ""}${trackingId}` : ""}
        </p>

        <fieldset className="mt-4">
          <legend className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">Reason</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {REASONS.map((r, i) => (
              <button
                key={r}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                onClick={() => setReason(r)}
                aria-pressed={reason === r}
                className={`min-h-11 rounded-xl border-2 px-3 py-2 font-display text-sm font-extrabold ${
                  reason === r ? "border-flame bg-flame-tint text-flame-dark" : "border-cardline bg-cream/60 text-ink-soft"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            aria-label="Cancellation reason"
            className="mt-2 min-h-11 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 font-display text-sm font-bold text-ink outline-none focus:border-frog"
          />
        </fieldset>

        <ul className="mt-4 space-y-2 rounded-xl bg-cream/60 p-3 text-sm font-semibold text-ink">
          <li>📦 Stock goes back on the shelf; the order leaves invoices, tracking and your shipped count.</li>
          {order.order_status === "booked" && (
            <li className="font-bold text-flame-dark">
              🚚 Also cancel waybill {trackingId ?? ""} with {courierName || "the courier"} so it is not collected or charged.
            </li>
          )}
          {order.order_status === "booked" && (
            <li>↩️ Courier already picked it up? Don&rsquo;t cancel here — let it come back as a return.</li>
          )}
        </ul>

        {error && (
          <p role="alert" className="mt-3 rounded-xl bg-flame-tint px-3 py-2 text-sm font-bold text-flame-dark">
            {error}
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Keep order
          </Button>
          <Button tone="flame" onClick={() => void submit()} disabled={busy || !reason.trim()}>
            {busy ? "Cancelling…" : "Cancel order"}
          </Button>
        </div>
      </section>
    </div>
  );
}
