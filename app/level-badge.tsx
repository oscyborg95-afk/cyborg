"use client";

import { useEffect, useState } from "react";
import type { Metrics } from "@/lib/metrics";
import { Flame } from "./components/ui";

// /api/metrics reads every order, manifest and settlement event, so each call
// is database egress proportional to the shop's whole history. The layout
// mounts this badge twice (desktop + tablet headers), so both copies share one
// poller, it only polls while the tab is visible, and it relies on the
// `metrics:refresh` event for instant updates after a dispatch (the event
// carries the workspace's freshly fetched metrics, so no second request).
const POLL_MS = 5 * 60_000;
const listeners = new Set<(m: Metrics) => void>();
let latest: Metrics | null = null;
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function loadMetrics(): Promise<void> {
  inFlight ??= fetch("/api/metrics")
    .then((r) => r.json())
    .then((d) => {
      if (d.metrics) publish(d.metrics as Metrics);
    })
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

const loadIfVisible = () => {
  if (document.visibilityState === "visible") void loadMetrics();
};
const catchUpOnReturn = () => {
  if (document.visibilityState === "visible" && Date.now() - fetchedAt > POLL_MS) void loadMetrics();
};
function publish(metrics: Metrics) {
  latest = metrics;
  fetchedAt = Date.now();
  listeners.forEach((fn) => fn(metrics));
}
const refreshNow = (event: Event) => {
  const shared = (event as CustomEvent<Metrics | undefined>).detail;
  if (shared) publish(shared);
  else void loadMetrics();
};

function subscribe(fn: (m: Metrics) => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1) {
    if (Date.now() - fetchedAt > POLL_MS) void loadMetrics();
    timer = setInterval(loadIfVisible, POLL_MS);
    document.addEventListener("visibilitychange", catchUpOnReturn);
    // Workspace fires this right after a dispatch so the chips update instantly.
    window.addEventListener("metrics:refresh", refreshNow);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size > 0) return;
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", catchUpOnReturn);
    window.removeEventListener("metrics:refresh", refreshNow);
  };
}

export function LevelBadge() {
  const [metrics, setMetrics] = useState<Metrics | null>(latest);

  useEffect(() => subscribe(setMetrics), []);

  if (!metrics) return null;

  const goalDone = metrics.shippedToday >= metrics.dailyGoal;

  return (
    <div className="flex items-center gap-2">
      {/* Today's goal — the daily hook, visible on every page. */}
      <span
        title={
          goalDone
            ? "Daily goal complete! 🎉"
            : `Ship ${metrics.dailyGoal - metrics.shippedToday} more today to hit your goal`
        }
        className={
          "flex items-center gap-1 rounded-full px-2.5 py-1 font-display text-sm font-extrabold " +
          (goalDone ? "bg-gold/30 text-gold-dark" : "bg-pond text-frog-dark")
        }
      >
        {goalDone ? "🎯" : "📦"} {metrics.shippedToday}/{metrics.dailyGoal}
      </span>
      {metrics.dispatchStreakDays > 0 && (
        <span
          title={
            metrics.streakAtRisk
              ? `Ship 1 order today or lose your ${metrics.dispatchStreakDays}-day streak!`
              : `${metrics.dispatchStreakDays}-day dispatch streak — safe for today`
          }
          className={
            "flex items-center gap-0.5 rounded-full px-2 py-1 font-display text-sm font-extrabold " +
            (metrics.streakAtRisk
              ? "animate-pulse bg-[#fdecec] text-[#c04545]"
              : "bg-flame-tint text-flame-dark")
          }
        >
          <Flame size={18} dim={metrics.streakAtRisk} />
          {metrics.dispatchStreakDays}
          {metrics.streakAtRisk && <span className="ml-0.5">!</span>}
        </span>
      )}
      <span className="flex items-center gap-1.5 rounded-full bg-gold/20 px-3 py-1 font-display text-sm font-extrabold text-ink">
        <span>🏆</span>
        Lv {metrics.level}
        <span className="text-ink-soft">
          {metrics.levelCount}/{metrics.levelTarget}
        </span>
      </span>
    </div>
  );
}
