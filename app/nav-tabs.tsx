"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  emoji: string;
  desc: string;
}

const PRIMARY_TABS: readonly NavItem[] = [
  { href: "/", label: "Workspace", emoji: "💬", desc: "Live inbox" },
  { href: "/orders", label: "Orders", emoji: "📦", desc: "Fulfillment" },
  { href: "/customers", label: "Customers", emoji: "👥", desc: "CRM profiles" },
];

const TOOL_GROUPS: readonly { category: string; items: readonly NavItem[] }[] = [
  {
    category: "Growth & Automation",
    items: [
      { href: "/ai", label: "AI Salesperson", emoji: "✨", desc: "Automated responses" },
      { href: "/followups", label: "Auto Follow-ups", emoji: "🔔", desc: "Recover cold leads" },
      { href: "/broadcast", label: "WhatsApp Blast", emoji: "📣", desc: "Bulk messaging" },
    ],
  },
  {
    category: "Finance & Insights",
    items: [
      { href: "/invoices", label: "Invoices", emoji: "🖨️", desc: "Packing slips" },
      { href: "/analytics", label: "Quest & Analytics", emoji: "🏆", desc: "Progress and stats" },
    ],
  },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function NavTabs() {
  const pathname = usePathname();
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isToolActive = TOOL_GROUPS.some((group) =>
    group.items.some((item) => isActive(pathname, item.href))
  );

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (desktopRef.current && !desktopRef.current.contains(event.target as Node)) {
        setDesktopOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDesktopOpen(false);
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
    };
  }, [moreOpen]);

  return (
    <>
      <nav aria-label="Main navigation" className="hidden items-center gap-1.5 lg:flex">
        {PRIMARY_TABS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-11 items-center gap-2 rounded-xl px-3 font-display text-sm font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frog ${
                active ? "bg-pond text-frog-dark shadow-2xs" : "text-ink-soft hover:bg-surface-soft hover:text-ink"
              }`}
            >
              <span aria-hidden="true">{item.emoji}</span>
              {item.label}
            </Link>
          );
        })}
        <div className="relative" ref={desktopRef}>
          <button
            type="button"
            onClick={() => setDesktopOpen((open) => !open)}
            aria-expanded={desktopOpen}
            aria-haspopup="menu"
            className={`flex min-h-11 items-center gap-2 rounded-xl px-3 font-display text-sm font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frog ${
              isToolActive || desktopOpen ? "bg-pond text-frog-dark" : "text-ink-soft hover:bg-surface-soft hover:text-ink"
            }`}
          >
            <span aria-hidden="true">✨</span> Tools <span aria-hidden="true">⌄</span>
          </button>
          {desktopOpen && (
            <div role="menu" className="card3d absolute right-0 z-50 mt-2 w-72 border-2 border-cardline bg-surface p-2.5 shadow-2xl">
              {TOOL_GROUPS.flatMap((group) => group.items).map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  onClick={() => setDesktopOpen(false)}
                  className={`flex items-center gap-3 rounded-xl p-2.5 font-display text-sm transition focus-visible:outline-2 focus-visible:outline-frog ${
                    isActive(pathname, item.href) ? "bg-pond font-extrabold text-frog-dark" : "text-ink hover:bg-surface-soft"
                  }`}
                >
                  <span className="text-lg" aria-hidden="true">{item.emoji}</span>
                  <span><strong className="block">{item.label}</strong><small className="font-body font-semibold text-ink-soft">{item.desc}</small></span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </nav>

      <nav aria-label="Mobile app navigation" className="lily-dock fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t-2 border-cardline bg-surface px-2 pt-1.5 lg:hidden">
        {PRIMARY_TABS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`mobile-dock-item relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl font-display text-[11px] font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-frog ${active ? "text-frog-dark" : "text-ink-soft"}`}
            >
              {active && <span className="absolute top-0 h-1 w-8 rounded-full bg-frog" />}
              <span className="text-xl leading-none" aria-hidden="true">{item.emoji}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          className={`mobile-dock-item relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl font-display text-[11px] font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-frog ${isToolActive ? "text-frog-dark" : "text-ink-soft"}`}
        >
          {isToolActive && <span className="absolute top-0 h-1 w-8 rounded-full bg-frog" />}
          <span className="text-xl leading-none" aria-hidden="true">•••</span>
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/45 lg:hidden" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setMoreOpen(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="more-tools-title" className="mobile-sheet max-h-[86dvh] w-full overflow-y-auto rounded-t-[2rem] border-x-2 border-t-2 border-cardline bg-surface px-4 pb-5 pt-3 shadow-2xl">
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-cardline" aria-hidden="true" />
            <div className="mb-4 flex items-center justify-between">
              <div><h2 id="more-tools-title" className="font-display text-xl font-extrabold text-ink">More tools</h2><p className="text-sm font-semibold text-ink-soft">Everything else, one thumb away.</p></div>
              <button ref={closeRef} type="button" onClick={() => setMoreOpen(false)} aria-label="Close more tools" className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-cardline bg-surface-soft font-display text-lg font-extrabold text-ink focus-visible:outline-2 focus-visible:outline-frog">✕</button>
            </div>
            {TOOL_GROUPS.map((group) => (
              <div key={group.category} className="mb-5">
                <h3 className="mb-2 font-display text-xs font-extrabold uppercase tracking-wider text-ink-soft">{group.category}</h3>
                <div className="grid gap-2">
                  {group.items.map((item) => (
                    <Link key={item.href} href={item.href} onClick={() => setMoreOpen(false)} className={`flex min-h-16 items-center gap-3 rounded-2xl border-2 p-3 transition focus-visible:outline-2 focus-visible:outline-frog ${isActive(pathname, item.href) ? "border-frog bg-pond" : "border-cardline bg-surface-soft"}`}>
                      <span className="text-2xl" aria-hidden="true">{item.emoji}</span>
                      <span className="min-w-0"><strong className="block font-display text-base font-extrabold text-ink">{item.label}</strong><span className="block text-sm font-semibold text-ink-soft">{item.desc}</span></span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            <div className="rounded-2xl border-2 border-sky/40 bg-sky-tint p-3 text-sm font-semibold text-ink">
              <strong className="font-display text-sky-dark">📲 Install on iPhone</strong>
              <p className="mt-1">In Safari, tap Share, then “Add to Home Screen”. On Android, use “Install app” from the browser menu.</p>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
