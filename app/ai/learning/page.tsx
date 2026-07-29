"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  LearningCandidate,
  LearningConversation,
  SalesStyleProfile,
} from "@/lib/types";
import { Froggy } from "../../components/froggy";
import { Button, Card } from "../../components/ui";

type LearningPayload = {
  candidates: LearningCandidate[];
  conversations: LearningConversation[];
  profile: SalesStyleProfile | null;
};

type CandidateFilter = "available" | "learned" | "missing";

const FILTERS: Array<{ key: CandidateFilter; label: string }> = [
  { key: "available", label: "Available" },
  { key: "learned", label: "Learned" },
  { key: "missing", label: "Missing chat" },
];

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  si: "Sinhala",
  ta: "Tamil",
  singlish: "Singlish",
  tanglish: "Tanglish",
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-LK", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function percentage(value: number) {
  return `${Math.round(value * 100)}%`;
}

function matchesFilter(candidate: LearningCandidate, filter: CandidateFilter) {
  if (filter === "learned") return candidate.approved;
  if (filter === "missing") return !candidate.approved && !candidate.chat_id;
  return !candidate.approved && Boolean(candidate.chat_id);
}

export default function AiLearningPage() {
  const [data, setData] = useState<LearningPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CandidateFilter>("available");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [teaching, setTeaching] = useState(false);
  const [removing, setRemoving] = useState("");
  const [confirming, setConfirming] = useState("");

  const load = useCallback(async (showSkeleton = false) => {
    if (showSkeleton) setLoading(true);
    try {
      const response = await fetch("/api/agent/learning", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load learning studio");
      setData(payload);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load learning studio");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const visibleCandidates = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.candidates.filter((candidate) => {
      if (!matchesFilter(candidate, filter)) return false;
      if (!needle) return true;
      return [
        candidate.customer_name,
        ...candidate.order_nos,
        ...candidate.products,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [data, filter, query]);

  const visibleAvailableKeys = visibleCandidates
    .filter((candidate) => !candidate.approved && candidate.chat_id)
    .map((candidate) => candidate.phone_key);
  const allVisibleSelected =
    visibleAvailableKeys.length > 0 &&
    visibleAvailableKeys.every((phoneKey) => selected.has(phoneKey));
  const hasProfile = Boolean(data?.profile && data.profile.sample_count > 0);

  function toggleCandidate(phoneKey: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(phoneKey)) next.delete(phoneKey);
      else next.add(phoneKey);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        visibleAvailableKeys.forEach((phoneKey) => next.delete(phoneKey));
      } else {
        visibleAvailableKeys.forEach((phoneKey) => next.add(phoneKey));
      }
      return next;
    });
  }

  async function teach() {
    if (selected.size === 0) return;
    setTeaching(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/agent/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_keys: [...selected] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not learn from selected chats");
      const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
      setSelected(new Set());
      setNotice(
        skipped
          ? `Learned from ${payload.approved} chat${payload.approved === 1 ? "" : "s"}. ${skipped} had no reusable replies.`
          : `✓ Learned from ${payload.approved} chat${payload.approved === 1 ? "" : "s"}. Team voice updated.`
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not learn from selected chats");
    } finally {
      setTeaching(false);
    }
  }

  async function removeConversation(phoneKey: string) {
    setRemoving(phoneKey);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/agent/learning/${encodeURIComponent(phoneKey)}`,
        { method: "DELETE" }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not remove this learning source");
      setConfirming("");
      setNotice("Learning source removed. Team voice recalculated.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this learning source");
    } finally {
      setRemoving("");
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
        {[88, 150, 260, 420].map((height) => (
          <div
            key={height}
            className="animate-pulse rounded-2xl border-2 border-cardline bg-surface-soft"
            style={{ height }}
          />
        ))}
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-3xl p-4 sm:p-6">
        <Card className="p-8 text-center sm:p-12">
          <Froggy mood="sleepy" size={76} bob={false} className="mx-auto" />
          <h1 className="mt-2 font-display text-xl font-extrabold text-ink">
            Learning studio unavailable
          </h1>
          <p className="mt-2 text-sm font-bold text-danger-ink">{error}</p>
          <Button tone="grape" className="mt-5" onClick={() => void load(true)}>
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  const profile = data.profile;
  const filterCounts = {
    available: data.candidates.filter((candidate) => matchesFilter(candidate, "available")).length,
    learned: data.candidates.filter((candidate) => matchesFilter(candidate, "learned")).length,
    missing: data.candidates.filter((candidate) => matchesFilter(candidate, "missing")).length,
  };

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 pb-28 sm:p-6 sm:pb-28">
      <Link
        href="/ai"
        className="inline-flex items-center gap-2 rounded-xl px-2 py-1 font-display text-sm font-extrabold text-ink-soft transition hover:bg-surface hover:text-grape-dark focus:outline-none focus:ring-2 focus:ring-grape"
      >
        ← AI Salesperson
      </Link>

      <header className="flex items-center gap-3 sm:gap-4">
        <Froggy mood={hasProfile ? "happy" : "thinking"} size={72} className="shrink-0" />
        <div className="min-w-0">
          <p className="font-display text-xs font-extrabold uppercase tracking-widest text-grape-dark">
            Learning studio
          </p>
          <h1 className="font-display text-2xl font-extrabold leading-tight text-ink sm:text-3xl">
            Teach your salesperson
          </h1>
          <p className="mt-1 max-w-2xl text-sm font-bold leading-relaxed text-ink-soft">
            Pick successful delivered-order chats. Froggy learns how your team speaks and finds
            similar winning replies when customers message.
          </p>
        </div>
      </header>

      {error && (
        <Card className="!border-danger-line bg-danger-bg p-4 font-display text-sm font-bold text-danger-ink">
          ⚠️ {error}
        </Card>
      )}
      {notice && (
        <div
          role="status"
          className="card3d !border-frog bg-pond p-4 font-display text-sm font-extrabold text-frog-dark"
        >
          {notice}
        </div>
      )}

      <section aria-labelledby="learning-engine-title">
        <Card className="overflow-hidden !border-grape">
          <div className="flex items-center justify-between gap-3 border-b-2 border-cardline bg-grape-tint px-4 py-3 sm:px-5">
            <div>
              <p className="font-display text-[10px] font-extrabold uppercase tracking-widest text-grape-dark">
                Learning engine
              </p>
              <h2 id="learning-engine-title" className="font-display text-base font-extrabold text-ink">
                Successful chats become better replies
              </h2>
            </div>
            <span
              className={`shrink-0 rounded-lg border-2 px-2.5 py-1 font-display text-[10px] font-extrabold uppercase ${
                hasProfile
                  ? "border-frog bg-pond text-frog-dark"
                  : "border-cardline bg-surface text-ink-soft"
              }`}
            >
              {hasProfile ? "Active" : "Ready to set up"}
            </span>
          </div>
          <div className="grid items-stretch gap-2 p-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:gap-3 sm:p-5">
            <div className="rounded-2xl border-2 border-cardline bg-surface-soft p-3">
              <span className="text-xl" aria-hidden>💬</span>
              <p className="mt-1 font-display text-sm font-extrabold text-ink">Approved chats</p>
              <p className="text-xs font-bold text-ink-soft">
                {data.conversations.length} trusted source{data.conversations.length === 1 ? "" : "s"}
              </p>
            </div>
            <span className="self-center text-center font-display text-lg font-extrabold text-ink-soft" aria-hidden>
              <span className="sm:hidden">↓</span><span className="hidden sm:inline">→</span>
            </span>
            <div className={`rounded-2xl border-2 p-3 ${hasProfile ? "border-grape bg-grape-tint" : "border-cardline bg-surface-soft"}`}>
              <span className="text-xl" aria-hidden>🎙️</span>
              <p className="mt-1 font-display text-sm font-extrabold text-ink">Level 1 · Team voice</p>
              <p className="text-xs font-bold text-ink-soft">
                {hasProfile ? "Learns your rhythm and tone" : "Starts after your first chat"}
              </p>
            </div>
            <span className="self-center text-center font-display text-lg font-extrabold text-ink-soft" aria-hidden>
              <span className="sm:hidden">↓</span><span className="hidden sm:inline">→</span>
            </span>
            <div className={`rounded-2xl border-2 p-3 ${hasProfile ? "border-sky bg-sky-tint" : "border-cardline bg-surface-soft"}`}>
              <span className="text-xl" aria-hidden>✨</span>
              <p className="mt-1 font-display text-sm font-extrabold text-ink">Level 2 · Similar reply</p>
              <p className="text-xs font-bold text-ink-soft">
                {hasProfile ? "Finds relevant winning examples" : "Activates with Team voice"}
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section aria-labelledby="team-voice-title">
        <Card className={`overflow-hidden ${hasProfile ? "!border-frog" : ""}`}>
          <div className={`flex items-start gap-3 border-b-2 border-cardline p-4 sm:p-5 ${hasProfile ? "bg-pond" : "bg-surface-soft"}`}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-xl shadow-sm" aria-hidden>
              {hasProfile ? "✓" : "🎙️"}
            </div>
            <div>
              <h2 id="team-voice-title" className="font-display text-lg font-extrabold text-ink">
                Team voice
              </h2>
              <p className="text-xs font-bold text-ink-soft">
                {hasProfile
                  ? `Updated ${formatDate(profile!.updated_at)}`
                  : "Approve a successful chat to create your voice profile."}
              </p>
            </div>
          </div>

          {hasProfile && profile ? (
            <div className="p-4 sm:p-5">
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5 sm:gap-3">
                {[
                  ["Sources", profile.sample_count],
                  ["Reply examples", profile.example_count],
                  ["Avg. reply", `${profile.traits.average_words} words`],
                  ["Question rate", percentage(profile.traits.question_rate)],
                  ["Emoji rate", percentage(profile.traits.emoji_rate)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border-2 border-cardline bg-surface-soft p-3">
                    <dt className="font-display text-[10px] font-extrabold uppercase text-ink-soft">
                      {label}
                    </dt>
                    <dd className="mt-1 font-display text-lg font-extrabold text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 rounded-2xl border-2 border-grape/30 bg-grape-tint p-4">
                <p className="font-display text-[10px] font-extrabold uppercase tracking-widest text-grape-dark">
                  What the salesperson learned
                </p>
                <p className="mt-2 text-sm font-bold leading-relaxed text-ink">
                  {profile.instructions}
                </p>
              </div>
            </div>
          ) : (
            <div className="p-5 text-center sm:p-8">
              <p className="font-display text-base font-extrabold text-ink">No team voice yet</p>
              <p className="mx-auto mt-1 max-w-lg text-sm font-bold text-ink-soft">
                Choose one or more available chats below. You stay in control of every source.
              </p>
            </div>
          )}

          <div className="grid gap-2 border-t-2 border-cardline bg-surface-soft p-4 text-xs font-bold text-ink-soft sm:grid-cols-2">
            <p className="flex gap-2"><span className="text-frog-dark" aria-hidden>🛡</span> Phone numbers, email and addresses are scrubbed.</p>
            <p className="flex gap-2"><span className="text-sky-dark" aria-hidden>●</span> Live catalog and policies always decide the facts.</p>
          </div>
        </Card>
      </section>

      <section aria-labelledby="candidate-title">
        <Card className="overflow-hidden">
          <div className="border-b-2 border-cardline p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="font-display text-[10px] font-extrabold uppercase tracking-widest text-flame-dark">
                  Delivered orders
                </p>
                <h2 id="candidate-title" className="font-display text-lg font-extrabold text-ink">
                  Choose chats to learn from
                </h2>
                <p className="text-xs font-bold text-ink-soft">Only approve conversations that represent your best selling style.</p>
              </div>
              {filter === "available" && visibleAvailableKeys.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 rounded-xl border-2 border-cardline bg-surface-soft px-3 py-2 font-display text-xs font-extrabold text-ink">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="h-4 w-4 accent-[var(--color-grape)]"
                  />
                  Select visible
                </label>
              )}
            </div>

            <label className="relative mt-4 block">
              <span className="sr-only">Search delivered-order chats</span>
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base" aria-hidden>⌕</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search customer, order number or product"
                className="w-full rounded-2xl border-2 border-cardline bg-cream/60 py-3 pl-11 pr-4 font-display text-sm font-bold text-ink outline-none transition placeholder:text-ink-soft focus:border-grape focus:ring-2 focus:ring-grape/20"
              />
            </label>

            <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Chat availability">
              {FILTERS.map((item) => {
                const active = filter === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(item.key)}
                    className={`shrink-0 rounded-xl border-2 px-3 py-2 font-display text-xs font-extrabold transition focus:outline-none focus:ring-2 focus:ring-grape ${
                      active
                        ? item.key === "available"
                          ? "border-grape bg-grape text-white"
                          : item.key === "learned"
                            ? "border-frog bg-pond text-frog-dark"
                            : "border-flame bg-flame-tint text-flame-dark"
                        : "border-cardline bg-surface text-ink-soft hover:border-grape"
                    }`}
                  >
                    {item.label} · {filterCounts[item.key]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="divide-y-2 divide-cardline">
            {visibleCandidates.length === 0 ? (
              <div className="p-8 text-center sm:p-10">
                <div className="text-3xl" aria-hidden>{query ? "⌕" : filter === "available" ? "🌱" : filter === "learned" ? "📚" : "💬"}</div>
                <p className="mt-2 font-display text-base font-extrabold text-ink">
                  {query
                    ? "No chats match your search"
                    : filter === "available"
                      ? "No new delivered chats available"
                      : filter === "learned"
                        ? "No chats learned yet"
                        : "No delivered orders are missing chats"}
                </p>
                <p className="mt-1 text-xs font-bold text-ink-soft">
                  {query ? "Try another customer, order number or product." : "This list updates as delivered orders and chats become available."}
                </p>
              </div>
            ) : (
              visibleCandidates.map((candidate) => {
                const eligible = !candidate.approved && Boolean(candidate.chat_id);
                const checked = selected.has(candidate.phone_key);
                return (
                  <article
                    key={candidate.phone_key}
                    className={`flex gap-3 p-4 transition sm:items-center sm:p-5 ${
                      checked ? "bg-grape-tint" : "bg-surface hover:bg-surface-soft"
                    }`}
                  >
                    {eligible ? (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCandidate(candidate.phone_key)}
                        aria-label={`Learn from ${candidate.customer_name || "this customer"} chat`}
                        className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-grape)] sm:mt-0"
                      />
                    ) : (
                      <div
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg font-display text-xs font-extrabold ${
                          candidate.approved ? "bg-frog text-white" : "bg-flame-tint text-flame-dark"
                        }`}
                        aria-hidden
                      >
                        {candidate.approved ? "✓" : "!"}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="font-display text-sm font-extrabold text-ink">
                          {candidate.customer_name || "Unnamed customer"}
                        </h3>
                        <span className={`rounded-md px-2 py-0.5 font-display text-[9px] font-extrabold uppercase ${
                          candidate.approved
                            ? "bg-pond text-frog-dark"
                            : candidate.chat_id
                              ? "bg-grape-tint text-grape-dark"
                              : "bg-flame-tint text-flame-dark"
                        }`}>
                          {candidate.approved ? "Learned" : candidate.chat_id ? "Ready" : "Chat unavailable"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-bold text-ink-soft">
                        {candidate.order_nos.length
                          ? candidate.order_nos.map((order) => `#${order}`).join(" · ")
                          : "Order number unavailable"}
                        {" · "}
                        {formatDate(candidate.delivered_at)}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs font-semibold text-ink">
                        {candidate.products.length ? candidate.products.join(" · ") : "Products unavailable"}
                      </p>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </Card>
      </section>

      <section aria-labelledby="sources-title">
        <div className="mb-3">
          <p className="font-display text-[10px] font-extrabold uppercase tracking-widest text-frog-dark">
            Trusted examples
          </p>
          <h2 id="sources-title" className="font-display text-lg font-extrabold text-ink">
            Approved learning sources
          </h2>
        </div>
        {data.conversations.length === 0 ? (
          <Card className="p-6 text-center">
            <p className="font-display text-sm font-extrabold text-ink">Your approved chats will appear here.</p>
            <p className="mt-1 text-xs font-bold text-ink-soft">No transcript or phone number is shown.</p>
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.conversations.map((conversation) => {
              const isConfirming = confirming === conversation.phone_key;
              return (
                <Card key={conversation.id} className="p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-frog bg-pond text-lg" aria-hidden>
                      💬
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display text-sm font-extrabold text-ink">
                          {conversation.customer_name || "Unnamed customer"}
                        </h3>
                        <span className="rounded-md bg-sky-tint px-2 py-0.5 font-display text-[9px] font-extrabold uppercase text-sky-dark">
                          {LANGUAGE_LABELS[conversation.language_style] ?? conversation.language_style.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs font-bold text-ink-soft">
                        {conversation.order_nos.map((order) => `#${order}`).join(" · ") || "Delivered order"}
                      </p>
                    </div>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-surface-soft p-3">
                      <dt className="text-[10px] font-extrabold uppercase text-ink-soft">Messages</dt>
                      <dd className="font-display text-lg font-extrabold text-ink">{conversation.message_count}</dd>
                    </div>
                    <div className="rounded-xl bg-grape-tint p-3">
                      <dt className="text-[10px] font-extrabold uppercase text-grape-dark">Reusable pairs</dt>
                      <dd className="font-display text-lg font-extrabold text-ink">{conversation.pairs.length}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 line-clamp-1 text-xs font-semibold text-ink-soft">
                    {conversation.products.join(" · ") || "Products not listed"}
                  </p>
                  <div className="mt-4 border-t-2 border-cardline pt-3">
                    {isConfirming ? (
                      <div className="rounded-xl border-2 border-danger-line bg-danger-bg p-3">
                        <p className="text-xs font-bold text-danger-ink">
                          Remove this chat and recalculate Team voice?
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            disabled={removing === conversation.phone_key}
                            onClick={() => void removeConversation(conversation.phone_key)}
                            className="rounded-lg bg-danger-ink px-3 py-2 font-display text-[11px] font-extrabold text-white focus:outline-none focus:ring-2 focus:ring-danger-ink disabled:opacity-50"
                          >
                            {removing === conversation.phone_key ? "Removing…" : "Yes, remove"}
                          </button>
                          <button
                            type="button"
                            disabled={removing === conversation.phone_key}
                            onClick={() => setConfirming("")}
                            className="rounded-lg border-2 border-cardline bg-surface px-3 py-2 font-display text-[11px] font-extrabold text-ink focus:outline-none focus:ring-2 focus:ring-grape disabled:opacity-50"
                          >
                            Keep it
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(conversation.phone_key)}
                        className="font-display text-xs font-extrabold text-danger-ink underline decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-danger-ink"
                      >
                        Remove from learning
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-cardline bg-cream/95 p-3 shadow-[0_-8px_24px_rgba(63,58,52,0.12)] backdrop-blur-sm">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <p className="font-display text-xs font-extrabold text-ink sm:text-sm">
              {selected.size} chat{selected.size === 1 ? "" : "s"} selected
              <span className="hidden text-ink-soft sm:inline"> · We’ll scrub private details first.</span>
            </p>
            <Button
              tone="grape"
              onClick={() => void teach()}
              disabled={teaching}
              className="shrink-0 px-4 text-xs sm:px-5 sm:text-sm"
            >
              {teaching ? "Learning…" : `Teach from ${selected.size} chat${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
