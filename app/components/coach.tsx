"use client";

// Cash the Frog, now with a voice. Duolingo-style character coaching:
// a speech bubble with a typewriter effect, contextual lines that rotate,
// and a tap-to-advance affordance so he always has something else to say.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Froggy, type FroggyMood } from "./froggy";

export interface CoachLine {
  text: string;
  mood?: FroggyMood;
}

// Time left until midnight in Colombo — the moment streaks and quests reset.
// Duolingo's best trick: a visible countdown makes "later" feel dangerous.
export function useColomboCountdown(): { label: string; hours: number } {
  const compute = useCallback(() => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Colombo",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
    const left = 86400 - elapsed;
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    return { label: h > 0 ? `${h}h ${m}m` : `${m}m`, hours: left / 3600 };
  }, []);
  const [state, setState] = useState(compute);
  useEffect(() => {
    const t = setInterval(() => setState(compute()), 30_000);
    return () => clearInterval(t);
  }, [compute]);
  return state;
}

// Typewriter speech bubble with a comic tail pointing left (at the mascot).
export function SpeechBubble({
  text,
  className = "",
  speed = 14,
}: {
  text: string;
  className?: string;
  speed?: number;
}) {
  // Parent remounts this component per line (key={text}), so `shown` always
  // starts at 0 for a new text — no synchronous reset needed in the effect.
  const [shown, setShown] = useState(0);
  const len = useRef(text.length);
  len.current = text.length;
  useEffect(() => {
    const t = setInterval(() => {
      setShown((n) => {
        if (n >= len.current) {
          clearInterval(t);
          return n;
        }
        return n + 1;
      });
    }, speed);
    return () => clearInterval(t);
  }, [speed]);

  const typing = shown < text.length;
  return (
    <div
      className={
        "relative animate-pop rounded-2xl border-2 border-cardline bg-white px-3.5 py-2.5 font-display text-sm font-bold text-ink shadow-[0_3px_0_var(--color-cardline)] " +
        className
      }
    >
      {/* tail */}
      <span className="absolute -left-[9px] top-4 h-4 w-4 rotate-45 border-b-2 border-l-2 border-cardline bg-white" />
      <span className="relative whitespace-pre-wrap">
        {text.slice(0, shown)}
        {typing && <span className="animate-flicker">▍</span>}
      </span>
    </div>
  );
}

export function Coach({
  lines,
  size = 84,
  rotateMs = 8000,
  className = "",
}: {
  lines: CoachLine[];
  size?: number;
  rotateMs?: number;
  className?: string;
}) {
  const [idx, setIdx] = useState(0);
  const safeLines = useMemo(
    () => (lines.length > 0 ? lines : [{ text: "Ribbit. Let's ship something! 🐸" }]),
    [lines]
  );
  const line = safeLines[idx % safeLines.length];

  // Auto-advance so he keeps talking; tapping skips ahead immediately.
  // A stale idx is harmless — the modulo above keeps it in range.
  useEffect(() => {
    if (safeLines.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % safeLines.length), rotateMs);
    return () => clearInterval(t);
  }, [safeLines, rotateMs]);

  return (
    <button
      type="button"
      onClick={() => setIdx((i) => (i + 1) % safeLines.length)}
      className={"flex w-full items-start gap-2 text-left " + className}
      title={safeLines.length > 1 ? "Tap — Cash has more to say" : undefined}
    >
      <Froggy mood={line.mood ?? "idle"} size={size} className="shrink-0" />
      <div className="min-w-0 flex-1 pt-1.5">
        <SpeechBubble key={line.text} text={line.text} />
        {safeLines.length > 1 && (
          <p className="mt-1 pl-2 font-display text-[10px] font-bold text-ink-soft/70">
            tap bubble for more · {(idx % safeLines.length) + 1}/{safeLines.length}
          </p>
        )}
      </div>
    </button>
  );
}
