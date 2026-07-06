"use client";

import { useEffect, useState } from "react";
import type { Metrics } from "@/lib/metrics";
import { Flame } from "./components/ui";

export function LevelBadge() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/metrics")
        .then((r) => r.json())
        .then((d) => d.metrics && setMetrics(d.metrics))
        .catch(() => {});
    load();
    const interval = setInterval(load, 30_000);
    // Workspace fires this right after a dispatch so the chips update instantly.
    window.addEventListener("metrics:refresh", load);
    return () => {
      clearInterval(interval);
      window.removeEventListener("metrics:refresh", load);
    };
  }, []);

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
          {metrics.delivered}/{metrics.levelTarget}
        </span>
      </span>
    </div>
  );
}
