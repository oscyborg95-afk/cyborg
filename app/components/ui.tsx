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
  ghost: "bg-white border-cardline text-ink",
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
  track = "#eee7d8",
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
    <div className={`h-5 w-full overflow-hidden rounded-full bg-[#eee7d8] ${className}`}>
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
