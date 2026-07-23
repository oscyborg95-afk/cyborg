import type { AgentMode, AgentRunStatus, ChatStateValue, CustomerLanguage } from "@/lib/types";

export const fieldClass =
  "w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-sm font-bold text-ink outline-none transition focus:border-frog focus:ring-2 focus:ring-frog/20 disabled:cursor-not-allowed";

export function AiStateBadge({
  mode,
  compact = false,
}: {
  mode: AgentMode;
  compact?: boolean;
}) {
  const config = {
    auto: { label: "AI LIVE", shell: "border-frog bg-pond text-frog-dark", dot: "bg-frog" },
    draft: { label: "DRAFT MODE", shell: "border-grape bg-grape-tint text-grape-dark", dot: "bg-grape" },
    off: { label: "AI OFF", shell: "border-cardline bg-surface-soft text-ink-soft", dot: "bg-ink-soft" },
  }[mode];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-xl border-2 font-display font-extrabold tracking-wide ${config.shell} ${
        compact ? "px-2 py-1 text-[10px]" : "px-3 py-2 text-xs"
      }`}
    >
      <span className={`relative h-2.5 w-2.5 rounded-full ${config.dot}`}>
        {mode === "auto" && <span className="absolute inset-0 animate-ping rounded-full bg-frog opacity-50" />}
      </span>
      {config.label}
    </span>
  );
}

export function StageBadge({ stage }: { stage: ChatStateValue | null }) {
  const label = (stage ?? "NEW").replaceAll("_", " ");
  return (
    <span className="inline-flex rounded-lg bg-sky-tint px-2 py-1 font-display text-[10px] font-extrabold tracking-wide text-sky-dark">
      {label}
    </span>
  );
}

export function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  const styles: Record<AgentRunStatus, string> = {
    sent: "bg-pond text-frog-dark",
    drafted: "bg-grape-tint text-grape-dark",
    handoff: "bg-flame-tint text-flame-dark",
    failed: "bg-danger-bg text-danger-ink",
    processing: "bg-sky-tint text-sky-dark",
    skipped: "bg-surface-soft text-ink-soft",
  };
  return (
    <span className={`rounded-lg px-2 py-1 font-display text-[10px] font-extrabold uppercase tracking-wide ${styles[status]}`}>
      {status}
    </span>
  );
}

export const languageName: Record<CustomerLanguage, string> = {
  auto: "Auto-detect",
  si: "සිංහල",
  ta: "தமிழ்",
  en: "English",
};

export function money(value: number): string {
  return `Rs. ${Math.round(value).toLocaleString("en-LK")}`;
}

export function timeAgo(value: string | number | null): string {
  if (!value) return "No recent activity";
  const time = typeof value === "number" ? value : new Date(value).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

