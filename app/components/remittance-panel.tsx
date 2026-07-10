"use client";

import { useEffect, useMemo, useState } from "react";
import type { CourierRemittance } from "@/lib/types";
import { Button, Card } from "./ui";

interface InvoiceSummary {
  invoice_no: string;
  lines: unknown[];
  gross_cod: number;
  collected_cod: number;
  vat: number;
  commission: number;
  delivery_charges: number;
  payable: number;
}

interface InvoicePreview {
  invoice: InvoiceSummary;
  matched_count: number;
  already_remitted_count: number;
  unmatched: Array<{ waybill_id: string; order_no: string; reason: string }>;
}

const money = (value: number) =>
  `Rs. ${Number(value || 0).toLocaleString("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const inputCls =
  "mt-1 w-full rounded-xl border-2 border-cardline bg-white/70 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-gold";

export function RemittancePanel({
  outstandingCount,
  outstandingGross,
  onRecorded,
}: {
  outstandingCount: number;
  outstandingGross: number;
  onRecorded: (message: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [history, setHistory] = useState<CourierRemittance[]>([]);
  const [amountReceived, setAmountReceived] = useState("");
  const [additionalTax, setAdditionalTax] = useState("0");
  const [otherDeductions, setOtherDeductions] = useState("0");
  const [paidAt, setPaidAt] = useState(
    `${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Colombo" })}T00:00`
  );
  const [cashApplied, setCashApplied] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadHistory() {
    const res = await fetch("/api/remittance");
    const data = await res.json();
    if (res.ok) setHistory(data.remittances ?? []);
  }
  useEffect(() => {
    let alive = true;
    fetch("/api/remittance")
      .then(async (res) => ({ ok: res.ok, data: await res.json() }))
      .then(({ ok, data }) => {
        if (alive && ok) setHistory(data.remittances ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const expectedNet = useMemo(
    () => Math.max(0, (preview?.invoice.payable ?? 0) - Number(additionalTax || 0) - Number(otherDeductions || 0)),
    [preview, additionalTax, otherDeductions]
  );
  const variance = Number(amountReceived || 0) - expectedNet;

  async function inspectInvoice(selected: File) {
    setFile(selected);
    setPreview(null);
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("invoice", selected);
      form.set("mode", "preview");
      const res = await fetch("/api/remittance", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPreview(data);
      setAmountReceived(String(data.invoice.payable));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read invoice");
    } finally {
      setBusy(false);
    }
  }

  async function recordPayout() {
    if (!file || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("invoice", file);
      form.set("mode", "commit");
      form.set("paid_at", new Date(paidAt).toISOString());
      form.set("amount_received", amountReceived);
      form.set("additional_tax", additionalTax);
      form.set("other_deductions", otherDeductions);
      form.set("cash_applied", String(cashApplied));
      form.set("notes", notes);
      const res = await fetch("/api/remittance", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const batch = data.remittance as CourierRemittance;
      await onRecorded(
        `💵 ${batch.invoice_no} recorded — ${money(batch.amount_received)} received` +
          (batch.cash_applied ? " and added to bank cash." : " (bank balance was left unchanged).")
      );
      setFile(null);
      setPreview(null);
      setNotes("");
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record payout");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="!border-gold bg-gold/10 p-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-64 flex-1">
          <p className="font-display text-sm font-extrabold text-ink">
            💵 Friday courier settlement
          </p>
          <p className="font-display text-xs font-bold text-ink-soft">
            Awaiting gross COD: {money(outstandingGross)} across {outstandingCount} delivered order
            {outstandingCount === 1 ? "" : "s"}. Upload the courier invoice and record the actual net bank deposit.
          </p>
        </div>
        <label className="cursor-pointer rounded-xl border-2 border-gold bg-white/70 px-4 py-2 font-display text-xs font-extrabold text-ink transition hover:bg-white">
          {busy ? "Reading…" : "📎 Choose InvoiceDetails.xlsx"}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            disabled={busy}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void inspectInvoice(selected);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      {error && <p className="mt-3 rounded-xl bg-flame-tint p-2 font-display text-xs font-bold text-flame-dark">{error}</p>}

      {preview && (
        <div className="mt-4 space-y-4 border-t-2 border-gold/30 pt-4">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Gross COD", preview.invoice.gross_cod],
              ["Delivery", -preview.invoice.delivery_charges],
              ["Commission", -preview.invoice.commission],
              ["Invoice VAT", -preview.invoice.vat],
              ["Invoice payable", preview.invoice.payable],
              ["Rows", preview.invoice.lines.length],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-white/70 p-2">
                <p className="font-display text-[10px] font-extrabold uppercase text-ink-soft">{label}</p>
                <p className="font-display text-sm font-extrabold text-ink">
                  {label === "Rows" ? value : money(Number(value))}
                </p>
              </div>
            ))}
          </div>

          <p className="font-display text-xs font-bold text-ink-soft">
            Invoice <span className="text-ink">{preview.invoice.invoice_no}</span> · {preview.matched_count} payable order
            {preview.matched_count === 1 ? "" : "s"} matched · {preview.unmatched.length} legacy/unmatched
            {preview.already_remitted_count ? ` · ${preview.already_remitted_count} already recorded` : ""}.
          </p>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="font-display text-xs font-bold text-ink-soft">
              Actual amount received (Rs.)
              <input type="number" min="0" step="0.01" className={inputCls} value={amountReceived} onChange={(e) => setAmountReceived(e.target.value)} />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Extra tax / withholding (Rs.)
              <input type="number" min="0" step="0.01" className={inputCls} value={additionalTax} onChange={(e) => setAdditionalTax(e.target.value)} />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Other deductions (Rs.)
              <input type="number" min="0" step="0.01" className={inputCls} value={otherDeductions} onChange={(e) => setOtherDeductions(e.target.value)} />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Paid at
              <input type="datetime-local" className={inputCls} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="font-display text-xs font-bold text-ink-soft">
              Notes (optional)
              <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Bank reference, tax note, adjustment…" />
            </label>
            <label className="flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2 font-display text-xs font-bold text-ink">
              <input type="checkbox" checked={cashApplied} onChange={(e) => setCashApplied(e.target.checked)} />
              Add receipt to bank cash
            </label>
          </div>
          <p className="font-display text-xs font-bold text-ink-soft">
            Expected after extra deductions: <span className="text-ink">{money(expectedNet)}</span> · Variance: {" "}
            <span className={Math.abs(variance) < 0.01 ? "text-frog-dark" : "text-flame-dark"}>{money(variance)}</span>
            {!cashApplied && " · Bank cash will not change (use this if you already updated the balance manually)."}
          </p>
          <Button tone="gold" onClick={recordPayout} disabled={busy || !amountReceived || !paidAt}>
            {busy ? "Recording…" : "✅ Record actual payout"}
          </Button>
        </div>
      )}

      {history.length > 0 && (
        <details className="mt-4 border-t-2 border-gold/30 pt-3">
          <summary className="cursor-pointer font-display text-xs font-extrabold text-ink">Previous courier settlements ({history.length})</summary>
          <div className="mt-2 space-y-2">
            {history.slice(0, 8).map((batch) => (
              <div key={batch.id} className="flex flex-wrap items-center gap-x-3 rounded-xl bg-white/60 px-3 py-2 font-display text-xs font-bold text-ink-soft">
                <span className="text-ink">{batch.invoice_no}</span>
                <span>{new Date(batch.paid_at).toLocaleDateString("en-GB")}</span>
                <span>{money(batch.amount_received)} received</span>
                <span className={Math.abs(batch.variance) < 0.01 ? "text-frog-dark" : "text-flame-dark"}>variance {money(batch.variance)}</span>
                {!batch.cash_applied && <span>bank unchanged</span>}
                <a className="ml-auto text-sky-dark underline" href={`/api/remittance/${batch.id}/invoice`}>invoice</a>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
