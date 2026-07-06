"use client";

// Cash the Frog — the operator's co-pilot mascot.
// Moods drive the eyes/mouth so the same character can react to events:
//   idle      – calm, blinking-ish, gentle bob
//   happy     – smiling (streak alive, good state)
//   celebrate – open cheer + sparkles (level up / dispatch win)
//   thinking  – looking up (AI parsing)
//   sleepy    – half-lidded (nothing happening / offline)

export type FroggyMood = "idle" | "happy" | "celebrate" | "thinking" | "sleepy";

export function Froggy({
  mood = "idle",
  size = 96,
  bob = true,
  className = "",
}: {
  mood?: FroggyMood;
  size?: number;
  bob?: boolean;
  className?: string;
}) {
  const cheeks = mood === "happy" || mood === "celebrate";
  return (
    <div
      className={(bob ? "animate-bob " : "") + className}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 120 120" width={size} height={size}>
        {mood === "celebrate" && (
          <g fill="var(--color-gold)">
            <path d="M18 20 l3 7 l7 3 l-7 3 l-3 7 l-3-7 l-7-3 l7-3 z" className="animate-flicker" />
            <path
              d="M100 12 l2 5 l5 2 l-5 2 l-2 5 l-2-5 l-5-2 l5-2 z"
              className="animate-flicker"
              style={{ animationDelay: "0.4s" }}
            />
            <path
              d="M104 74 l2 5 l5 2 l-5 2 l-2 5 l-2-5 l-5-2 l5-2 z"
              className="animate-flicker"
              style={{ animationDelay: "0.8s" }}
            />
          </g>
        )}

        {/* body */}
        <ellipse cx="60" cy="72" rx="42" ry="40" fill="var(--color-frog)" />
        <ellipse cx="60" cy="86" rx="30" ry="24" fill="#eafbdc" />

        {/* feet */}
        <ellipse cx="34" cy="108" rx="13" ry="8" fill="var(--color-frog-dark)" />
        <ellipse cx="86" cy="108" rx="13" ry="8" fill="var(--color-frog-dark)" />

        {/* eye bumps */}
        <circle cx="40" cy="34" r="19" fill="var(--color-frog)" />
        <circle cx="80" cy="34" r="19" fill="var(--color-frog)" />
        <circle cx="40" cy="33" r="14" fill="#ffffff" />
        <circle cx="80" cy="33" r="14" fill="#ffffff" />

        {/* pupils by mood */}
        {mood === "sleepy" ? (
          <g stroke="var(--color-ink)" strokeWidth="3" strokeLinecap="round">
            <path d="M32 34 q8 6 16 0" fill="none" />
            <path d="M72 34 q8 6 16 0" fill="none" />
          </g>
        ) : (
          <g fill="var(--color-ink)">
            <circle cx={40} cy={mood === "thinking" ? 27 : 35} r="6" />
            <circle cx={80} cy={mood === "thinking" ? 27 : 35} r="6" />
            <circle cx={38} cy={mood === "thinking" ? 25 : 33} r="2" fill="#fff" />
            <circle cx={78} cy={mood === "thinking" ? 25 : 33} r="2" fill="#fff" />
          </g>
        )}

        {cheeks && (
          <g fill="#ff9db1" opacity="0.8">
            <circle cx="30" cy="62" r="7" />
            <circle cx="90" cy="62" r="7" />
          </g>
        )}

        {/* mouth by mood */}
        {mood === "celebrate" ? (
          <path d="M44 66 q16 24 32 0 q-16 10 -32 0 z" fill="#b93b52" />
        ) : mood === "happy" ? (
          <path d="M42 64 q18 20 36 0" fill="none" stroke="var(--color-ink)" strokeWidth="4" strokeLinecap="round" />
        ) : mood === "thinking" ? (
          <path d="M52 70 q8 4 16 0" fill="none" stroke="var(--color-ink)" strokeWidth="4" strokeLinecap="round" />
        ) : mood === "sleepy" ? (
          <path d="M50 70 q10 3 20 0" fill="none" stroke="var(--color-ink)" strokeWidth="4" strokeLinecap="round" />
        ) : (
          <path d="M46 66 q14 12 28 0" fill="none" stroke="var(--color-ink)" strokeWidth="4" strokeLinecap="round" />
        )}

        {mood === "sleepy" && (
          <text x="96" y="30" fontSize="16" fill="var(--color-ink-soft)" fontFamily="var(--font-display)">
            z
          </text>
        )}
        {mood === "thinking" && (
          <g fill="var(--color-sky)" className="animate-flicker">
            <circle cx="100" cy="40" r="3" />
            <circle cx="108" cy="30" r="4" />
          </g>
        )}
      </svg>
    </div>
  );
}
