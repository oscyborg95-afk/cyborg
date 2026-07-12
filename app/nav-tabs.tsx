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
    <div className="order-last flex w-full min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] md:order-none md:w-auto md:flex-1 md:justify-center">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-1.5 font-display text-sm font-bold transition md:flex-none md:px-3 " +
              (active
                ? "bg-pond text-frog-dark"
                : "text-ink-soft hover:bg-pond/60 hover:text-ink")
            }
          >
            <span className="text-base leading-none">{t.emoji}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
