"use client";

// The dopamine layer. localStorage-diffed one-time celebrations:
//   LevelUpOverlay  – full-screen takeover when the level increases
//   BadgeOverlay    – "BADGE UNLOCKED" when a new badge is earned
//   XPBurst         – floating "+1 📦" burst after every dispatch
//   playChime       – tiny WebAudio arpeggio (no assets), call from a user gesture

import { useEffect, useState } from "react";
import type { Badge, Metrics } from "@/lib/metrics";
import { Froggy } from "./froggy";
import { Button, Confetti } from "./ui";

// --- sound ---------------------------------------------------------------

type ChimeKind = "win" | "levelup" | "badge";

const NOTES: Record<ChimeKind, number[]> = {
  win: [523.25, 659.25, 783.99], // C5 E5 G5
  levelup: [523.25, 659.25, 783.99, 1046.5], // + C6
  badge: [659.25, 830.61, 987.77], // E5 G#5 B5
};

// Short synth arpeggio. Must be triggered from (or shortly after) a user
// gesture or the browser will block the AudioContext — callers ensure that.
export function playChime(kind: ChimeKind = "win") {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    NOTES[kind].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const t = now + i * 0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.55);
    });
    setTimeout(() => ctx.close(), 1400);
  } catch {
    // sound is garnish — never break the app over it
  }
}

// --- localStorage diffing --------------------------------------------------

const LS_LEVEL = "dc:lastLevel";
const LS_BADGES = "dc:earnedBadges";

// Watches metrics and pops celebrations exactly once per level-up / new badge,
// surviving reloads via localStorage. First-ever visit just records a baseline.
export function useCelebrations(metrics: Metrics | null) {
  const [levelUp, setLevelUp] = useState<number | null>(null);
  const [newBadges, setNewBadges] = useState<Badge[]>([]);

  useEffect(() => {
    if (!metrics) return;
    try {
      const prevLevel = Number(localStorage.getItem(LS_LEVEL) ?? "");
      if (Number.isFinite(prevLevel) && prevLevel > 0 && metrics.level > prevLevel) {
        setLevelUp(metrics.level);
      }
      localStorage.setItem(LS_LEVEL, String(metrics.level));

      const earned = metrics.badges.filter((b) => b.earned).map((b) => b.id);
      const prevRaw = localStorage.getItem(LS_BADGES);
      if (prevRaw !== null) {
        const prev: string[] = JSON.parse(prevRaw);
        const fresh = metrics.badges.filter((b) => b.earned && !prev.includes(b.id));
        if (fresh.length > 0) setNewBadges(fresh);
      }
      localStorage.setItem(LS_BADGES, JSON.stringify(earned));
    } catch {
      // private mode etc. — celebrations just won't fire
    }
  }, [metrics]);

  return {
    levelUp,
    newBadges,
    dismissLevelUp: () => setLevelUp(null),
    dismissBadges: () => setNewBadges([]),
  };
}

// --- overlays ---------------------------------------------------------------

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-6 backdrop-blur-[2px]">
      <Confetti run count={120} />
      <div className="card3d relative w-full max-w-sm animate-pop bg-white p-8 text-center">
        {children}
      </div>
    </div>
  );
}

export function LevelUpOverlay({ level, onClose }: { level: number; onClose: () => void }) {
  return (
    <Overlay>
      <div className="flex justify-center">
        <Froggy mood="celebrate" size={120} />
      </div>
      <p className="mt-2 font-display text-sm font-extrabold uppercase tracking-[0.25em] text-gold-dark">
        Level up!
      </p>
      <p
        className="font-display text-7xl font-extrabold text-ink"
        style={{ animation: "count-glow 1.6s ease-in-out infinite" }}
      >
        {level}
      </p>
      <p className="mt-1 font-display text-sm font-bold text-ink-soft">
        Cash is losing his mind. You&apos;re officially a Level {level} operator. 🐸👑
      </p>
      <Button
        tone="gold"
        className="mt-5 w-full !py-3"
        onClick={() => {
          playChime("levelup");
          onClose();
        }}
      >
        CLAIM IT 🎉
      </Button>
    </Overlay>
  );
}

export function BadgeOverlay({ badges, onClose }: { badges: Badge[]; onClose: () => void }) {
  const badge = badges[0];
  if (!badge) return null;
  return (
    <Overlay>
      <p className="font-display text-sm font-extrabold uppercase tracking-[0.25em] text-gold-dark">
        Badge unlocked!
      </p>
      <div className="mx-auto mt-4 flex h-28 w-28 items-center justify-center rounded-full border-4 border-gold bg-gold/15 text-6xl shadow-[0_0_40px_rgba(255,200,0,0.55)]">
        <span className="animate-bob">{badge.emoji}</span>
      </div>
      <p className="mt-4 font-display text-2xl font-extrabold text-ink">{badge.name}</p>
      <p className="font-display text-sm font-bold text-ink-soft">{badge.desc}</p>
      {badges.length > 1 && (
        <p className="mt-2 font-display text-xs font-extrabold text-gold-dark">
          +{badges.length - 1} more waiting…
        </p>
      )}
      <Button
        tone="gold"
        className="mt-5 w-full !py-3"
        onClick={() => {
          playChime("badge");
          onClose();
        }}
      >
        {badges.length > 1 ? "NEXT →" : "CLAIM 🏅"}
      </Button>
    </Overlay>
  );
}

// Queue-aware wrapper: shows badges one at a time, then calls done.
export function BadgeQueue({ badges, onDone }: { badges: Badge[]; onDone: () => void }) {
  const [idx, setIdx] = useState(0);
  if (badges.length === 0 || idx >= badges.length) return null;
  return (
    <BadgeOverlay
      badges={badges.slice(idx)}
      onClose={() => (idx + 1 >= badges.length ? onDone() : setIdx(idx + 1))}
    />
  );
}

// --- XP burst ----------------------------------------------------------------

// Floating "+1 📦" that rockets up from the bottom of the screen after a
// dispatch, with a subtitle for goal/streak context. Keyed remount per burst.
export function XPBurst({
  burst,
}: {
  burst: { id: number; title: string; sub?: string } | null;
}) {
  if (!burst) return null;
  return (
    <div key={burst.id} className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center">
      <div className="xp-burst card3d bg-white px-6 py-3 text-center">
        <p className="font-display text-2xl font-extrabold text-frog-dark">{burst.title}</p>
        {burst.sub && <p className="font-display text-xs font-extrabold text-ink-soft">{burst.sub}</p>}
      </div>
    </div>
  );
}
