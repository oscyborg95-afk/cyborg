import type { ChatStateValue, CustomerLanguage } from "@/lib/types";

export const fieldClass =
  "min-h-11 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-base font-bold text-ink outline-none transition focus:border-frog focus:ring-2 focus:ring-frog/20 disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm";

export function StageBadge({ stage }: { stage: ChatStateValue | null }) {
  const label = (stage ?? "NEW").replaceAll("_", " ");
  return (
    <span className="inline-flex rounded-lg bg-sky-tint px-2 py-1 font-display text-[10px] font-extrabold tracking-wide text-sky-dark">
      {label}
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
