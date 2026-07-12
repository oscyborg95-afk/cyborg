"use client";

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

// ---- Chunky pressable button -------------------------------------------------

type Tone = "frog" | "sky" | "grape" | "flame" | "gold" | "ghost";

const TONE_CLASS: Record<Tone, string> = {
  frog: "bg-frog border-frog-dark text-white",
  sky: "bg-sky border-sky-dark text-white",
  grape: "bg-grape border-grape-dark text-white",
  flame: "bg-flame border-flame-dark text-white",
  gold: "bg-gold border-gold-dark text-ink",
  ghost: "bg-surface border-cardline text-ink",
};

export function Button({
  tone = "frog",
  className = "",
  children,
  ...rest
}: { tone?: Tone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn3d ${TONE_CLASS[tone]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

// ---- Card --------------------------------------------------------------------

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`card3d ${className}`}>{children}</div>;
}

// ---- Circular progress ring --------------------------------------------------

export function ProgressRing({
  value,
  size = 180,
  stroke = 16,
  color = "var(--color-frog)",
  track = "var(--color-track)",
  children,
}: {
  value: number; // 0..100
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circ - (clamped / 100) * circ;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  );
}

// ---- Chunky horizontal progress bar -----------------------------------------

export function ProgressBar({
  value,
  tone = "var(--color-frog)",
  className = "",
}: {
  value: number;
  tone?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={`h-5 w-full overflow-hidden rounded-full bg-track ${className}`}>
      <div
        className="relative h-full rounded-full"
        style={{
          width: `${clamped}%`,
          background: tone,
          transition: "width 1s cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        <span className="absolute inset-x-1 top-1 h-1.5 rounded-full bg-white/40" />
      </div>
    </div>
  );
}

// ---- Streak flame ------------------------------------------------------------

export function Flame({ size = 44, dim = false }: { size?: number; dim?: boolean }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={dim ? "" : "animate-flicker"}
      style={{ opacity: dim ? 0.28 : 1 }}
    >
      <path
        d="M16 2 C18 8 24 10 24 18 a8 8 0 0 1 -16 0 C8 13 12 12 13 7 C14 10 15 11 16 2 Z"
        fill={dim ? "#cdbfa8" : "var(--color-flame)"}
      />
      <path
        d="M16 12 C17 15 20 16 20 20 a4 4 0 0 1 -8 0 C12 17 15 16 16 12 Z"
        fill={dim ? "#e3d8c4" : "var(--color-gold)"}
      />
    </svg>
  );
}

// ---- Confetti burst ----------------------------------------------------------

const CONFETTI_COLORS = [
  "var(--color-frog)",
  "var(--color-sky)",
  "var(--color-grape)",
  "var(--color-flame)",
  "var(--color-gold)",
];

export function Confetti({ count = 90, run = true }: { count?: number; run?: boolean }) {
  const [pieces, setPieces] = useState<number[]>([]);
  useEffect(() => {
    if (!run) return;
    setPieces(Array.from({ length: count }, (_, i) => i));
    const t = setTimeout(() => setPieces([]), 3600);
    return () => clearTimeout(t);
  }, [run, count]);

  if (pieces.length === 0) return null;
  return (
    <>
      {pieces.map((i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 0.6;
        const duration = 2.2 + Math.random() * 1.4;
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        const rounded = Math.random() > 0.5;
        return (
          <span
            key={i}
            className="confetti-piece"
            style={{
              left: `${left}%`,
              background: color,
              borderRadius: rounded ? "50%" : "3px",
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
            }}
          />
        );
      })}
    </>
  );
}

// ---- Activity bar chart --------------------------------------------------
// Duolingo-style 14-day chart: chunky rounded bars that grow in on mount,
// today highlighted, daily-goal line to beat. Pure CSS transitions, no libs.

export interface ChartDay {
  key: string;
  label: string;
  dispatched: number;
  delivered: number;
  returned: number;
}

export function ActivityChart({
  days,
  goal,
  height = 148,
}: {
  days: ChartDay[];
  goal: number;
  height?: number;
}) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 60); // let bars mount at 0 first
    return () => clearTimeout(t);
  }, []);

  const max = Math.max(goal, ...days.map((d) => Math.max(d.dispatched, d.delivered)), 4);
  const px = (n: number) => (grown ? Math.round((n / max) * height) : 0);
  const today = days[days.length - 1]?.key;

  return (
    <div>
      <div className="relative" style={{ height: height + 26 }}>
        {/* goal line */}
        <div
          className="absolute inset-x-0 z-0 border-t-2 border-dashed border-gold"
          style={{ bottom: 26 + Math.round((goal / max) * height), transition: "bottom 0.8s" }}
        >
          <span className="absolute -top-4 right-0 font-display text-[10px] font-extrabold text-gold-dark">
            🎯 goal {goal}
          </span>
        </div>

        <div className="absolute inset-0 z-10 flex items-end justify-between gap-1">
          {days.map((d, i) => {
            const isToday = d.key === today;
            return (
              <div
                key={d.key}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${d.key} — ${d.dispatched} dispatched, ${d.delivered} delivered${d.returned ? `, ${d.returned} returned` : ""}`}
              >
                <div className="flex h-full w-full items-end justify-center gap-[3px]">
                  {/* dispatched */}
                  <div className="flex w-1/2 max-w-4 flex-col items-center justify-end">
                    {d.dispatched > 0 && grown && (
                      <span className="font-display text-[10px] font-extrabold leading-none text-frog-dark">
                        {d.dispatched}
                      </span>
                    )}
                    <div
                      className="w-full rounded-t-md rounded-b-sm"
                      style={{
                        height: px(d.dispatched),
                        minHeight: d.dispatched > 0 ? 6 : 2,
                        background: isToday ? "var(--color-gold)" : "var(--color-frog)",
                        opacity: d.dispatched > 0 ? 1 : 0.15,
                        transition: `height 0.7s cubic-bezier(0.22,1,0.36,1) ${i * 0.04}s`,
                      }}
                    />
                  </div>
                  {/* delivered */}
                  <div className="flex w-1/2 max-w-4 flex-col items-center justify-end">
                    <div
                      className="w-full rounded-t-md rounded-b-sm"
                      style={{
                        height: px(d.delivered),
                        minHeight: d.delivered > 0 ? 6 : 2,
                        background: "var(--color-sky)",
                        opacity: d.delivered > 0 ? 1 : 0.15,
                        transition: `height 0.7s cubic-bezier(0.22,1,0.36,1) ${i * 0.04 + 0.1}s`,
                      }}
                    />
                  </div>
                </div>
                <span
                  className={
                    "font-display text-[10px] font-extrabold " +
                    (isToday ? "rounded-md bg-gold/25 px-1 text-gold-dark" : "text-ink-soft")
                  }
                >
                  {isToday ? "Today" : d.label}
                  {d.returned > 0 && <span title={`${d.returned} returned`}> ⚠️</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex justify-center gap-4 font-display text-[11px] font-bold text-ink-soft">
        <span>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-frog align-middle" />
          Dispatched
        </span>
        <span>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-sky align-middle" />
          Delivered
        </span>
        <span>
          <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-gold align-middle" />
          Today
        </span>
      </div>
    </div>
  );
}

// Animated number that counts up from 0 to `value` on mount / change.
export function CountUp({
  value,
  format = (n: number) => String(Math.round(n)),
  duration = 900,
  className = "",
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={className}>{format(display)}</span>;
}
