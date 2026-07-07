"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Workspace", emoji: "💬" },
  { href: "/orders", label: "Orders", emoji: "📦" },
  { href: "/invoices", label: "Invoices", emoji: "🖨️" },
  { href: "/broadcast", label: "Blast", emoji: "📣" },
  { href: "/analytics", label: "Quest", emoji: "🏆" },
] as const;

export function NavTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              "flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-display text-sm font-bold transition " +
              (active
                ? "bg-pond text-frog-dark"
                : "text-ink-soft hover:bg-pond/60 hover:text-ink")
            }
          >
            <span className="text-base leading-none">{t.emoji}</span>
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
