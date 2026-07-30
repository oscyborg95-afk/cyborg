"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RadarDashboard, RadarPlatform, RadarProduct, RadarStage } from "@/lib/product-radar";
import { Button, Card, ProgressRing } from "../components/ui";

const stageMeta: Record<RadarStage, { label: string; classes: string; dot: string }> = {
  emerging: { label: "Emerging", classes: "bg-pond text-frog-dark border-frog/30", dot: "bg-frog" },
  validated: { label: "Validated", classes: "bg-sky-tint text-sky-dark border-sky/30", dot: "bg-sky" },
  scaling: { label: "Scaling", classes: "bg-grape-tint text-grape-dark border-grape/30", dot: "bg-grape" },
  saturated: { label: "Saturated", classes: "bg-flame-tint text-flame-dark border-flame/30", dot: "bg-flame" },
  watch: { label: "Watch", classes: "bg-surface-soft text-ink-soft border-cardline", dot: "bg-ink-soft" },
};

function ageLabel(value: string | null) {
  if (!value) return "Date unknown";
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  return days === 0 ? "Started today" : `Running ${days} day${days === 1 ? "" : "s"}`;
}

function StageBadge({ stage }: { stage: RadarStage }) {
  const meta = stageMeta[stage];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 font-display text-xs font-extrabold ${meta.classes}`}>
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function ProductMedia({ product, compact = false }: { product: RadarProduct; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (product.thumbnailUrl && !failed) {
    // Provider media hosts are intentionally dynamic; Next/Image cannot safely
    // enumerate them in remotePatterns.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={product.thumbnailUrl} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />;
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_center,var(--color-pond)_0_12%,transparent_13%),linear-gradient(135deg,var(--color-sky-tint),var(--color-grape-tint))] text-center">
      <span className={compact ? "text-2xl" : "text-4xl"} aria-hidden="true">📦</span>
      {!compact && <span className="mt-1 px-2 font-display text-[10px] font-extrabold uppercase tracking-wide text-ink-soft">Creative pending</span>}
    </div>
  );
}

function RadarOrbit({ score }: { score: number }) {
  return (
    <div className="relative flex h-36 w-36 shrink-0 items-center justify-center" aria-label={`Opportunity score ${score} out of 100`}>
      <span className="absolute inset-1 rounded-full border-2 border-dashed border-frog/35" />
      <span className="absolute inset-5 rounded-full border-2 border-sky/35" />
      <span className="absolute left-3 top-8 h-3 w-3 rounded-full border-2 border-surface bg-gold shadow-md" />
      <span className="absolute bottom-4 right-7 h-2.5 w-2.5 rounded-full border-2 border-surface bg-grape" />
      <ProgressRing value={score} size={96} stroke={9} color="var(--color-frog)">
        <strong className="font-display text-3xl font-extrabold text-ink">{score}</strong>
        <span className="font-display text-[9px] font-extrabold uppercase tracking-wider text-ink-soft">signal</span>
      </ProgressRing>
    </div>
  );
}

function EvidencePanel({ product, onClose }: { product: RadarProduct; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus?.focus();
    };
  }, [onClose]);
  const competitors = [...new Set(product.evidence.map((item) => item.advertiser).filter(Boolean))];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/35" role="dialog" aria-modal="true" aria-labelledby="evidence-title" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={panelRef} className="h-full w-full max-w-2xl overflow-y-auto border-l-2 border-cardline bg-cream p-4 shadow-2xl sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <span className="font-display text-xs font-extrabold uppercase tracking-[0.16em] text-grape-dark">Competitor evidence</span>
            <h2 id="evidence-title" className="mt-1 font-display text-2xl font-extrabold leading-tight text-ink">{product.name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2"><StageBadge stage={product.stage} /><span className="font-display text-sm font-extrabold text-ink-soft">{product.score}/100 public signal score</span></div>
          </div>
          <Button ref={closeRef} tone="ghost" onClick={onClose} aria-label="Close evidence panel" className="!px-3">✕</Button>
        </div>
        <Card className="mb-4 border-grape/30 bg-grape-tint p-4">
          <p className="font-display text-xs font-extrabold uppercase tracking-wide text-grape-dark">Advertiser roster · {competitors.length}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {competitors.length ? competitors.map((name) => <span key={name} className="rounded-lg border border-grape/25 bg-surface px-2.5 py-1 text-sm font-bold text-ink">{name}</span>) : <span className="text-sm font-bold text-ink-soft">No named Meta advertisers yet.</span>}
          </div>
        </Card>
        <div className="space-y-3">
          {product.evidence.map((ad) => (
            <article key={ad.id} className="card3d overflow-hidden">
              <div className="flex gap-3 p-3">
                <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-cardline"><ProductMedia product={{ ...product, thumbnailUrl: ad.mediaUrl }} compact /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-md px-2 py-0.5 font-display text-[10px] font-extrabold uppercase ${ad.platform === "meta" ? "bg-sky-tint text-sky-dark" : "bg-ink text-surface"}`}>{ad.platform}</span>
                    <span className="text-xs font-extrabold text-ink-soft">{ageLabel(ad.startDate)}</span>
                  </div>
                  <h3 className="mt-1 truncate font-display text-base font-extrabold text-ink">{ad.advertiser || ad.title || "Unknown advertiser"}</h3>
                  <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink-soft">{ad.copy || ad.title || "Creative text unavailable"}</p>
                  {ad.offer && <p className="mt-1 font-display text-xs font-extrabold text-flame-dark">🏷 {ad.offer}</p>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-cardline bg-surface-soft/60 px-3 py-2">
                {ad.platforms.map((platform) => <span key={platform} className="text-xs font-bold text-ink-soft">{platform}</span>)}
                <span className="flex-1" />
                {ad.adUrl && <a href={ad.adUrl} target="_blank" rel="noreferrer" className="font-display text-xs font-extrabold text-sky-dark underline decoration-2 underline-offset-2">Original ad ↗</a>}
                {ad.landingUrl && <a href={ad.landingUrl} target="_blank" rel="noreferrer" className="font-display text-xs font-extrabold text-frog-dark underline decoration-2 underline-offset-2">Landing page ↗</a>}
              </div>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}

export default function ProductRadarPage() {
  const [dashboard, setDashboard] = useState<RadarDashboard | null>(null);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<RadarProduct | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<RadarStage | "all">("all");
  const [platform, setPlatform] = useState<RadarPlatform | "all">("all");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/radar", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load Product Radar");
      setDashboard(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Product Radar");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function scanNow() {
    setScanning(true);
    setError("");
    try {
      const response = await fetch("/api/radar/scan", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Scan failed");
      setDashboard(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  const filtered = useMemo(() => (dashboard?.products || []).filter((product) =>
    (stage === "all" || product.stage === stage) &&
    (platform === "all" || product.platforms.includes(platform)) &&
    product.name.toLowerCase().includes(query.toLowerCase())
  ), [dashboard, query, stage, platform]);
  const top = dashboard?.products[0];

  if (!dashboard && !error) {
    return <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6" aria-busy="true"><Card className="p-5"><div className="h-6 w-48 animate-pulse rounded-lg bg-track" /><div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-track" /></Card><div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]"><div className="h-64 animate-pulse rounded-[1.25rem] bg-track" /><div className="h-64 animate-pulse rounded-[1.25rem] bg-track" /></div></main>;
  }
  if (!dashboard) {
    return <main className="mx-auto max-w-3xl p-5"><Card className="border-danger-line bg-danger-bg p-6"><div className="text-3xl" aria-hidden="true">📡</div><h1 className="mt-2 font-display text-2xl font-extrabold text-danger-ink">Product Radar is temporarily unavailable</h1><p className="mt-2 font-bold text-danger-ink">{error || "The signal feed could not be loaded."}</p><p className="mt-1 text-sm font-bold text-ink-soft">Try once more. If this continues, check the server database connection; no Apify token or database secret is shown here.</p><Button tone="ghost" className="mt-4" onClick={load}>Try again</Button></Card></main>;
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-xs font-extrabold uppercase tracking-[0.18em] text-frog-dark">Product intelligence</span>
            <span className={`rounded-md border px-2 py-0.5 font-display text-[10px] font-extrabold uppercase ${dashboard.dataMode === "live" ? "border-frog/30 bg-pond text-frog-dark" : "border-gold/50 bg-flame-tint text-flame-dark"}`}>{dashboard.dataMode === "demo" ? "Demo data" : dashboard.dataMode}</span>
          </div>
          <h1 className="font-display text-3xl font-extrabold leading-tight text-ink">Sri Lanka Cosmetics Radar</h1>
          <p className="mt-1 text-sm font-bold text-ink-soft">
            {dashboard.focus.category} · Meta ads shown in {dashboard.focus.marketCountry}
            {dashboard.focus.includeTikTok ? " · International TikTok enrichment on" : ""}
          </p>
          <p className="mt-1 text-xs font-bold text-ink-soft">{dashboard.lastRun?.status === "completed" ? `Last scanned ${new Date(dashboard.lastRun.completedAt!).toLocaleString("en-LK")}` : "No successful live scan yet"} · {dashboard.nextScan}</p>
        </div>
        <Button onClick={scanNow} disabled={scanning || !dashboard.configured} className="w-full sm:w-auto">{scanning ? "Scanning Apify…" : "⌁ Scan now"}</Button>
      </header>

      {!dashboard.configured && <Card className="flex flex-col gap-3 border-gold/50 bg-flame-tint p-4 sm:flex-row sm:items-center"><div className="text-2xl" aria-hidden="true">🔑</div><div className="flex-1"><p className="font-display font-extrabold text-ink">Connect the live signal</p><p className="text-sm font-bold text-ink-soft">Add <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-ink">APIFY_TOKEN</code> to your server environment. The examples below are clearly marked demo data.</p></div><a href="https://console.apify.com/settings/integrations" target="_blank" rel="noreferrer" className="font-display text-sm font-extrabold text-flame-dark underline decoration-2 underline-offset-2">Open Apify token settings ↗</a></Card>}
      {dashboard.lastRun?.status === "completed" && dashboard.lastRun.error && (
        <div role="status" className="rounded-xl border-2 border-gold/50 bg-flame-tint px-4 py-3 font-bold text-ink">
          The latest scan completed with partial provider coverage. Some countries or competitor results may be missing; the available evidence is still shown below.
        </div>
      )}
      {error && <div role="alert" className="rounded-xl border-2 border-danger-line bg-danger-bg px-4 py-3 font-bold text-danger-ink">{error}</div>}

      {top ? (
        <Card className="relative overflow-hidden border-frog/40 bg-[linear-gradient(110deg,var(--color-surface)_0_64%,var(--color-pond)_64%)] p-4 sm:p-5">
          <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className="font-display text-xs font-extrabold uppercase tracking-[0.16em] text-gold-dark">★ Today&apos;s strongest signal</p>
              <div className="mt-2 flex items-start gap-3">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border-2 border-cardline bg-surface shadow-sm"><ProductMedia product={top} compact /></div>
                <div className="min-w-0"><h2 className="font-display text-xl font-extrabold leading-tight text-ink sm:text-2xl">{top.name}</h2><div className="mt-2"><StageBadge stage={top.stage} /></div></div>
              </div>
              <ul className="mt-4 grid gap-1.5 text-sm font-bold text-ink sm:grid-cols-3">{top.reasons.map((reason) => <li key={reason} className="flex gap-2"><span className="text-frog" aria-hidden="true">●</span><span>{reason}</span></li>)}</ul>
              <button onClick={() => setSelected(top)} className="mt-4 font-display text-sm font-extrabold text-frog-dark underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-frog">Inspect competitor evidence →</button>
            </div>
            <RadarOrbit score={top.score} />
          </div>
        </Card>
      ) : <Card className="p-8 text-center"><div className="text-4xl" aria-hidden="true">📡</div><h2 className="mt-2 font-display text-xl font-extrabold text-ink">No signals yet</h2><p className="mt-1 text-sm font-bold text-ink-soft">Run the first scan to discover and validate product candidates automatically.</p></Card>}

      <section aria-label="Radar summary" className="grid grid-cols-2 divide-x divide-y divide-cardline overflow-hidden rounded-2xl border-2 border-cardline bg-surface sm:grid-cols-4 sm:divide-y-0">
        {[["Candidates", dashboard.summary.candidates, "📦"], ["Advertisers", dashboard.summary.advertisers, "🕵️"], ["Active creatives", dashboard.summary.activeCreatives, "🎬"], ["Emerging picks", dashboard.summary.emergingPicks, "🌱"]].map(([label, value, icon]) => <div key={String(label)} className="p-3 sm:p-4"><p className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">{icon} {label}</p><p className="font-display text-2xl font-extrabold text-ink">{value}</p></div>)}
      </section>

      <section>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <h2 className="flex-1 font-display text-xl font-extrabold text-ink">Ranked discoveries</h2>
          <label className="sr-only" htmlFor="radar-search">Search products</label>
          <input id="radar-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products…" className="rounded-xl border-2 border-cardline bg-surface px-3 py-2 text-sm font-bold text-ink outline-none focus:border-frog sm:w-48" />
          <select aria-label="Filter by stage" value={stage} onChange={(e) => setStage(e.target.value as RadarStage | "all")} className="rounded-xl border-2 border-cardline bg-surface px-3 py-2 text-sm font-bold text-ink outline-none focus:border-frog"><option value="all">All stages</option>{Object.entries(stageMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select>
          <select aria-label="Filter by platform" value={platform} onChange={(e) => setPlatform(e.target.value as RadarPlatform | "all")} className="rounded-xl border-2 border-cardline bg-surface px-3 py-2 text-sm font-bold text-ink outline-none focus:border-frog"><option value="all">All platforms</option><option value="tiktok">TikTok</option><option value="meta">Meta</option></select>
        </div>
        <div className="space-y-3">
          {filtered.map((product, index) => (
            <button key={product.key} onClick={() => setSelected(product)} className="card3d group grid w-full grid-cols-[auto_1fr] gap-3 p-3 text-left transition hover:-translate-y-0.5 hover:border-frog/50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-frog sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:p-4">
              <div className="relative h-20 w-20 overflow-hidden rounded-2xl border-2 border-cardline bg-surface-soft"><ProductMedia product={product} compact /><span className="absolute left-1 top-1 rounded-md bg-ink/80 px-1.5 py-0.5 font-display text-[10px] font-extrabold text-white">#{index + 1}</span></div>
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-display text-lg font-extrabold leading-tight text-ink">{product.name}</h3><StageBadge stage={product.stage} /></div><p className="mt-1 line-clamp-1 text-sm font-bold text-ink-soft">{product.reasons[0]}</p><div className="mt-2 flex flex-wrap gap-1.5">{product.platforms.map((item) => <span key={item} className="rounded-md bg-surface-soft px-2 py-0.5 text-[11px] font-extrabold uppercase text-ink-soft">{item}</span>)}<span className="rounded-md bg-grape-tint px-2 py-0.5 text-[11px] font-extrabold text-grape-dark">{product.competitorCount} competitors</span><span className="rounded-md bg-sky-tint px-2 py-0.5 text-[11px] font-extrabold text-sky-dark">{product.activeAdCount} active ads</span></div></div>
              <div className="col-span-2 flex items-center justify-between border-t border-cardline pt-2 sm:col-span-1 sm:block sm:border-0 sm:pt-0 sm:text-right"><span className="font-display text-3xl font-extrabold text-ink">{product.score}</span><span className="ml-1 font-display text-[10px] font-extrabold uppercase text-ink-soft sm:block">signal score</span><span className="ml-auto font-display text-sm font-extrabold text-frog-dark sm:ml-0 sm:mt-2 sm:block">View evidence →</span></div>
            </button>
          ))}
          {!filtered.length && <Card className="p-6 text-center"><p className="font-display font-extrabold text-ink">No products match those filters.</p><button className="mt-2 text-sm font-extrabold text-frog-dark underline" onClick={() => { setQuery(""); setStage("all"); setPlatform("all"); }}>Clear filters</button></Card>}
        </div>
      </section>
      <p className="pb-2 text-center text-xs font-bold text-ink-soft">Product Radar scores public advertising signals—not sales, profit, CPA, ROAS, spend, or guaranteed product performance.</p>
      {selected && <EvidencePanel product={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
