"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SalesAccount } from "@/lib/types";
import { Button, Card } from "../components/ui";

type ReportType = "orders" | "delivery";
type FileFormat = "csv" | "pdf";

const fieldClass =
  "mt-1.5 min-h-11 w-full rounded-xl border-2 border-cardline bg-cream px-3 py-2 font-display text-base font-bold text-ink outline-none transition-colors focus:border-frog focus-visible:ring-2 focus-visible:ring-frog/30 sm:text-sm";

function filenameFromHeader(header: string | null): string | null {
  if (!header) return null;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to an ordinary filename or a local default.
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}

function safeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|\r\n]/g, "-").trim() || "report";
}

export default function ReportsPage() {
  const [accounts, setAccounts] = useState<SalesAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [seller, setSeller] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const busyRef = useRef(false);

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError("");
    try {
      const response = await fetch("/api/sales-accounts?includeInactive=true", { cache: "no-store" });
      if (!response.ok) throw new Error("Couldn’t load sellers. Please try again.");
      const data = (await response.json()) as { accounts?: SalesAccount[] };
      if (!Array.isArray(data.accounts)) throw new Error("Couldn’t load sellers. Please try again.");
      setAccounts(data.accounts);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : "Couldn’t load sellers. Please try again.");
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAccounts(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAccounts]);

  const invalidRange = Boolean(from && to && from > to);

  async function download(type: ReportType, format: FileFormat) {
    if (busyRef.current || invalidRange) return;
    busyRef.current = true;
    const key = `${type}-${format}`;
    setBusyKey(key);
    setDownloadError("");

    try {
      const params = new URLSearchParams({ type, format, seller });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const response = await fetch(`/api/reports/export?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || "The report couldn’t be prepared. Please try again.");
      }

      const blob = await response.blob();
      if (!blob.size) throw new Error("The report was empty. Please try a different date range.");
      const filename = safeFilename(
        filenameFromHeader(response.headers.get("content-disposition")) ||
          `${type}-report-${new Date().toISOString().slice(0, 10)}.${format}`
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The download failed. Please try again.");
    } finally {
      busyRef.current = false;
      setBusyKey("");
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4 pb-12 sm:space-y-6 sm:p-6">
      <header className="space-y-3">
        <Link
          href="/orders"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 font-display text-sm font-extrabold text-frog-dark underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frog"
        >
          <span aria-hidden="true">←</span> Back to Orders
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-display text-xs font-extrabold uppercase tracking-[0.16em] text-frog-dark">Your business, on paper</p>
            <h1 className="font-display text-3xl font-extrabold leading-tight text-ink sm:text-4xl">Reports &amp; exports</h1>
            <p className="mt-1 max-w-2xl font-display text-sm font-bold text-ink-soft sm:text-base">
              Download complete records for all sellers, or focus on just one.
            </p>
          </div>
          <span className="rounded-xl border-2 border-frog/25 bg-pond px-3 py-2 font-display text-xs font-extrabold text-frog-dark">
            Full history · not just the 200 orders on screen
          </span>
        </div>
      </header>

      <Card className="overflow-hidden">
        <div className="border-b-2 border-cardline bg-pond/55 px-4 py-3 sm:px-5">
          <h2 className="font-display text-lg font-extrabold text-ink">Choose what to include</h2>
          <p className="font-display text-sm font-bold text-ink-soft">These filters apply to both reports. Leave dates blank for all time.</p>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-3 sm:p-5">
          <label className="font-display text-sm font-extrabold text-ink">
            Seller
            <select
              className={fieldClass}
              value={seller}
              onChange={(event) => setSeller(event.target.value)}
              aria-describedby={accountsError ? "seller-error" : undefined}
            >
              <option value="all">All sellers</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </select>
            {accountsLoading && <span className="mt-1 block text-xs font-bold text-ink-soft">Loading sellers…</span>}
          </label>
          <label className="font-display text-sm font-extrabold text-ink">
            From <span className="font-bold text-ink-soft">(optional)</span>
            <input className={fieldClass} type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="font-display text-sm font-extrabold text-ink">
            To <span className="font-bold text-ink-soft">(optional)</span>
            <input className={fieldClass} type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        {(invalidRange || accountsError) && (
          <div className="space-y-1 px-4 pb-4 font-display text-sm font-bold sm:px-5" role="alert">
            {invalidRange && <p className="text-danger-ink">The From date must be before or the same as the To date.</p>}
            {accountsError && (
              <p id="seller-error" className="text-danger-ink">
                {accountsError} <button type="button" onClick={() => void loadAccounts()} className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-frog">Retry</button>
              </p>
            )}
          </div>
        )}
      </Card>

      {downloadError && (
        <div role="alert" className="rounded-2xl border-2 border-danger-line bg-danger-bg px-4 py-3 font-display text-sm font-bold text-danger-ink">
          {downloadError}
        </div>
      )}

      <section aria-label="Available reports" className="grid gap-4 md:grid-cols-2">
        <ReportCard
          number="01"
          emoji="📦"
          title="Orders report"
          tint="bg-pond"
          accent="text-frog-dark"
          description="Every order, from sale to settlement. See what sold and what was collected."
          dateNote="Date filter uses the order creation date."
          fields="Seller · customer · items · order value · payment · status · tracking"
          type="orders"
          busyKey={busyKey}
          invalidRange={invalidRange}
          onDownload={download}
        />
        <ReportCard
          number="02"
          emoji="🚚"
          title="Delivery report"
          tint="bg-sky-tint"
          accent="text-sky-dark"
          description="Follow each parcel through the courier journey, including delivery attempts and outcomes."
          dateNote="Date filter uses the last courier event date."
          fields="Seller · customer · tracking · courier · each attempt · outcome"
          type="delivery"
          busyKey={busyKey}
          invalidRange={invalidRange}
          onDownload={download}
        />
      </section>

      <p className="rounded-xl border border-cardline bg-surface/70 px-4 py-3 font-display text-xs font-bold leading-relaxed text-ink-soft">
        🔒 Reports include customer names, phone numbers, and addresses. Store or share downloaded files carefully.
      </p>
    </main>
  );
}

function ReportCard({
  number,
  emoji,
  title,
  tint,
  accent,
  description,
  dateNote,
  fields,
  type,
  busyKey,
  invalidRange,
  onDownload,
}: {
  number: string;
  emoji: string;
  title: string;
  tint: string;
  accent: string;
  description: string;
  dateNote: string;
  fields: string;
  type: ReportType;
  busyKey: string;
  invalidRange: boolean;
  onDownload: (type: ReportType, format: FileFormat) => Promise<void>;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className={`${tint} flex items-start justify-between gap-3 border-b-2 border-cardline p-4 sm:p-5`}>
        <div>
          <p className={`font-display text-xs font-extrabold uppercase tracking-[0.15em] ${accent}`}>Report {number}</p>
          <h2 className="mt-1 font-display text-2xl font-extrabold leading-tight text-ink">{title}</h2>
        </div>
        <span className="text-4xl" aria-hidden="true">{emoji}</span>
      </div>
      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <p className="font-display text-sm font-bold leading-relaxed text-ink">{description}</p>
        <div className="mt-4 space-y-2 border-l-[3px] border-cardline pl-3 font-display text-xs font-bold leading-relaxed text-ink-soft">
          <p>{dateNote}</p>
          <p>{fields}</p>
        </div>
        <div className="mt-auto grid grid-cols-2 gap-2 pt-6">
          {(["csv", "pdf"] as const).map((format) => {
            const key = `${type}-${format}`;
            const active = busyKey === key;
            return (
              <Button
                key={format}
                type="button"
                tone={format === "pdf" ? (type === "delivery" ? "sky" : "frog") : "ghost"}
                className="min-h-11 px-2 text-sm sm:px-3"
                disabled={invalidRange || active}
                aria-busy={active}
                onClick={() => void onDownload(type, format)}
              >
                {active ? "Preparing…" : `↓ ${format.toUpperCase()}`}
              </Button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
