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
  source_line_count: number;
  matched_count: number;
  already_remitted_count: number;
  ignored: Array<{ waybill_id: string; order_no: string; reason: string }>;
}

interface PayoutSummary {
  total_paid_to_me: number;
  paid_this_month: number;
  total_invoice_expected: number;
  total_gross_cod: number;
  courier_costs_and_deductions: number;
  total_variance: number;
  settlement_count: number;
  last_payout: { amount: number; paid_at: string; invoice_no: string } | null;
  month_label: string;
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
  const [summary, setSummary] = useState<PayoutSummary | null>(null);
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
    if (res.ok) {
      setHistory(data.remittances ?? []);
      setSummary(data.summary ?? null);
      setError(null);
    } else {
      setError(data.error || "Could not load payout history");
    }
  }
  useEffect(() => {
    let alive = true;
    fetch("/api/remittance")
      .then(async (res) => ({ ok: res.ok, data: await res.json() }))
      .then(({ ok, data }) => {
        if (alive && ok) {
          setHistory(data.remittances ?? []);
          setSummary(data.summary ?? null);
          setError(null);
        } else if (alive) {
          setError(data.error || "Could not load payout history");
        }
      })
      .catch(() => {
        if (alive) setError("Could not load payout history");
      });
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
    <Card className="!border-gold bg-gold/10 p-4 sm:p-5">
      <section aria-labelledby="payout-summary-title">
        <div className="mb-3">
          <h2 id="payout-summary-title" className="font-display text-lg font-extrabold text-ink">Courier paid you {summary ? money(summary.total_paid_to_me) : "—"}</h2>
          <p className="text-xs font-bold text-ink-soft">Saved settlements use the actual cash received, not gross COD.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {[
            ["Actual cash received", summary ? summary.total_paid_to_me : null, "text-frog-dark", summary ? "All recorded payouts" : "Payout history unavailable"],
            [`Paid in ${summary?.month_label ?? "this month"}`, summary ? summary.paid_this_month : null, "text-frog-dark", summary ? "Actual receipts this month" : "Payout history unavailable"],
            ["Last payout", summary ? (summary.last_payout?.amount ?? 0) : null, "text-grape-dark", summary?.last_payout ? `${new Date(summary.last_payout.paid_at).toLocaleDateString("en-LK", { timeZone: "Asia/Colombo" })} · ${summary.last_payout.invoice_no}` : summary ? "No payouts recorded" : "Payout history unavailable"],
            ["Awaiting courier payout", outstandingGross, "text-gold-dark", `${outstandingCount} delivered order${outstandingCount === 1 ? "" : "s"} · gross COD`],
          ].map(([label, value, color, note], index) => (
            <div
              key={String(label)}
              className={`rounded-xl border-2 bg-white/70 p-3 ${
                index === 0 ? "col-span-2 border-frog lg:col-span-1" : "border-cardline"
              }`}
            >
              <p className="font-display text-[11px] font-extrabold uppercase tracking-wide text-ink-soft">{label}</p>
              <p className={`mt-1 font-display font-extrabold ${index === 0 ? "text-3xl" : "text-xl"} ${color}`}>{value === null ? "—" : money(Number(value))}</p>
              <p className="mt-1 text-[11px] font-bold text-ink-soft">{note}</p>
            </div>
          ))}
        </div>
        <div className="mt-2 grid gap-1 rounded-xl border border-gold/40 bg-white/50 p-2 text-[11px] font-bold text-ink-soft sm:grid-cols-2 lg:grid-cols-4">
          <span className="flex items-center justify-between gap-3 rounded-lg bg-surface/60 px-2 py-1.5"><span>Invoice expected</span><strong className="text-ink">{summary ? money(summary.total_invoice_expected) : "—"}</strong></span>
          <span className="flex items-center justify-between gap-3 rounded-lg bg-surface/60 px-2 py-1.5"><span>Gross COD settled</span><strong className="text-ink">{summary ? money(summary.total_gross_cod) : "—"}</strong></span>
          <span className="flex items-center justify-between gap-3 rounded-lg bg-surface/60 px-2 py-1.5"><span>Courier deductions</span><strong className="text-gold-dark">{summary ? money(summary.courier_costs_and_deductions) : "—"}</strong></span>
          <span className="flex items-center justify-between gap-3 rounded-lg bg-surface/60 px-2 py-1.5"><span>Total variance</span><strong className={Math.abs(summary?.total_variance ?? 0) < 0.01 ? "text-frog-dark" : "text-flame-dark"}>{summary ? money(summary.total_variance) : "—"}</strong></span>
        </div>
      </section>

      <div className="my-4 border-t-2 border-gold/30" />
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-64 flex-1">
          <p className="font-display text-sm font-extrabold text-ink">
            💵 Friday courier settlement
          </p>
          <p className="font-display text-xs font-bold text-ink-soft">
            Upload the weekly courier invoice, verify the expected amount, then record the actual cash received.
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
              ["My orders", preview.invoice.lines.length],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-white/70 p-2">
                <p className="font-display text-[10px] font-extrabold uppercase text-ink-soft">{label}</p>
                <p className="font-display text-sm font-extrabold text-ink">
                  {label === "My orders" ? value : money(Number(value))}
                </p>
              </div>
            ))}
          </div>

          <p className="font-display text-xs font-bold text-ink-soft">
            Invoice <span className="text-ink">{preview.invoice.invoice_no}</span> · {preview.matched_count} of {preview.source_line_count} rows belong to your shipped orders · {preview.ignored.length} ignored
            {preview.already_remitted_count ? ` · ${preview.already_remitted_count} already recorded` : ""}.
          </p>

          {preview.matched_count === 0 && (
            <p className="rounded-xl bg-flame-tint p-3 font-display text-xs font-extrabold text-flame-dark">
              No invoice waybill matches your stored shipping manifests. Nothing from this invoice can be recorded.
            </p>
          )}

          {preview.ignored.length > 0 && (
            <details className="rounded-xl bg-white/60 px-3 py-2">
              <summary className="cursor-pointer font-display text-xs font-extrabold text-ink-soft">
                View {preview.ignored.length} ignored invoice row{preview.ignored.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                {preview.ignored.map((row) => (
                  <p key={`${row.waybill_id}:${row.order_no}`} className="font-mono text-[10px] text-ink-soft">
                    {row.waybill_id} — {row.reason}
                  </p>
                ))}
              </div>
            </details>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="font-display text-xs font-bold text-ink-soft">
              Actual cash received (Rs.)
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
          <Button
            tone="gold"
            onClick={recordPayout}
            disabled={busy || preview.matched_count === 0 || !amountReceived || !paidAt}
          >
            {busy ? "Recording…" : "✅ Record actual payout"}
          </Button>
        </div>
      )}

      <section className="mt-4 border-t-2 border-gold/30 pt-4" aria-labelledby="settlement-history-title">
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <h3 id="settlement-history-title" className="font-display text-sm font-extrabold text-ink">Recent courier settlements</h3>
            <p className="text-[11px] font-bold text-ink-soft">Actual receipt, expected amount and courier deductions.</p>
          </div>
          <span className="font-display text-xs font-extrabold text-ink-soft">{history.length} saved</span>
        </div>
        {history.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-cardline bg-white/40 p-6 text-center text-xs font-bold text-ink-soft">No courier payouts have been recorded yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border-2 border-cardline bg-white/60">
            <table className="w-full min-w-[720px] text-left font-display text-xs">
              <thead className="border-b-2 border-cardline bg-surface-soft text-[10px] uppercase text-ink-soft">
                <tr>
                  <th className="px-3 py-2">Paid date / invoice</th>
                  <th className="px-3 py-2">Actual cash received</th>
                  <th className="px-3 py-2">Invoice expected</th>
                  <th className="px-3 py-2">Gross COD</th>
                  <th className="px-3 py-2">Courier costs &amp; deductions</th>
                  <th className="px-3 py-2">Variance</th>
                  <th className="px-3 py-2">File</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cardline">
                {history.slice(0, 10).map((batch) => {
                  const deductions =
                    Number(batch.delivery_charges || 0) +
                    Number(batch.commission || 0) +
                    Number(batch.invoice_vat || 0) +
                    Number(batch.additional_tax || 0) +
                    Number(batch.other_deductions || 0);
                  return (
                    <tr key={batch.id} className="text-ink">
                      <td className="px-3 py-3"><strong>{new Date(batch.paid_at).toLocaleDateString("en-LK", { timeZone: "Asia/Colombo" })}</strong><br /><span className="text-[10px] text-ink-soft">{batch.invoice_no}</span></td>
                      <td className="px-3 py-3 font-extrabold text-frog-dark">{money(batch.amount_received)}{!batch.cash_applied && <><br /><span className="text-[10px] text-ink-soft">bank unchanged</span></>}</td>
                      <td className="px-3 py-3">{money(batch.invoice_payable)}</td>
                      <td className="px-3 py-3">{money(batch.gross_cod)}</td>
                      <td className="px-3 py-3 text-gold-dark">{money(deductions)}</td>
                      <td className={`px-3 py-3 font-extrabold ${Math.abs(batch.variance) < 0.01 ? "text-frog-dark" : "text-flame-dark"}`}>{money(batch.variance)}</td>
                      <td className="px-3 py-3"><a className="text-sky-dark underline focus:outline-none focus:ring-2 focus:ring-sky" href={`/api/remittance/${batch.id}/invoice`}>Download</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Card>
  );
}
