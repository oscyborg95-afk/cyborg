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

interface ToolGroup {
  category: string;
  items: NavItem[];
}

const PRIMARY_TABS: readonly NavItem[] = [
  { href: "/", label: "Workspace", emoji: "💬", desc: "Live chat, desk & actions" },
  { href: "/orders", label: "Orders", emoji: "📦", desc: "Fulfillment & dispatches" },
  { href: "/customers", label: "Customers", emoji: "👥", desc: "CRM & profiles" },
];

const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    category: "Growth & Automation",
    items: [
      { href: "/ai", label: "AI Salesperson", emoji: "✨", desc: "Automated responses & AI sales" },
      { href: "/followups", label: "Auto Follow-ups", emoji: "🔔", desc: "Chase cold leads automatically" },
      { href: "/broadcast", label: "WhatsApp Blast", emoji: "📣", desc: "Bulk customer messaging" },
    ],
  },
  {
    category: "Finance & Insights",
    items: [
      { href: "/invoices", label: "Invoices", emoji: "🖨️", desc: "Thermal & A4 packing slips" },
      { href: "/analytics", label: "Quest & Analytics", emoji: "🏆", desc: "XP progress & dispatch stats" },
    ],
  },
];

export function NavTabs() {
  const pathname = usePathname();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Check if current route is within the Tools dropdown
  const isToolActive = TOOL_GROUPS.some((group) =>
    group.items.some((item) => pathname.startsWith(item.href))
  );

  // Find active item for mobile trigger label
  const activePrimary = PRIMARY_TABS.find((t) =>
    t.href === "/" ? pathname === "/" : pathname.startsWith(t.href)
  );
  const activeTool = TOOL_GROUPS.flatMap((g) => g.items).find((t) =>
    pathname.startsWith(t.href)
  );
  const currentActiveLabel = activePrimary?.label || activeTool?.label || "Navigation";
  const currentActiveEmoji = activePrimary?.emoji || activeTool?.emoji || "🧭";

  // Close menus on route change
  useEffect(() => {
    setDropdownOpen(false);
    setMobileMenuOpen(false);
  }, [pathname]);

  // Click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownOpen]);

  // Keyboard navigation (Escape key closes menus)
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDropdownOpen(false);
        setMobileMenuOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  return (
    <nav aria-label="Main Navigation" className="flex items-center gap-1.5 min-w-0">
      {/* Desktop Navigation (lg+) */}
      <div className="hidden lg:flex items-center gap-1.5 min-w-0">
        {/* Primary core tabs */}
        {PRIMARY_TABS.map((t) => {
          const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={
                "flex items-center gap-2 rounded-xl px-3 py-1.5 font-display text-sm font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frog " +
                (active
                  ? "bg-pond text-frog-dark shadow-2xs"
                  : "text-ink-soft hover:bg-surface-soft hover:text-ink")
              }
            >
              <span className="text-base leading-none" aria-hidden="true">
                {t.emoji}
              </span>
              <span>{t.label}</span>
            </Link>
          );
        })}

        {/* Tools Dropdown Trigger */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((prev) => !prev)}
            aria-expanded={dropdownOpen}
            aria-haspopup="true"
            aria-label="More tools and feature menu"
            className={
              "flex items-center gap-2 rounded-xl px-3 py-1.5 font-display text-sm font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frog " +
              (isToolActive || dropdownOpen
                ? "bg-pond text-frog-dark shadow-2xs"
                : "text-ink-soft hover:bg-surface-soft hover:text-ink")
            }
          >
            <span className="text-base leading-none" aria-hidden="true">
              ✨
            </span>
            <span>Tools</span>
            {isToolActive && (
              <span
                className="h-2 w-2 rounded-full bg-frog animate-pulse"
                title="Active tool open"
              />
            )}
            <svg
              className={`h-4 w-4 transition-transform duration-200 ${
                dropdownOpen ? "rotate-180" : ""
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Tools Dropdown Menu */}
          {dropdownOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-72 card3d bg-surface p-2.5 shadow-2xl border-2 border-cardline animate-pop z-50"
            >
              {TOOL_GROUPS.map((group, gIdx) => (
                <div key={group.category} className={gIdx > 0 ? "mt-2 pt-2 border-t border-cardline" : ""}>
                  <div className="px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider text-ink-soft">
                    {group.category}
                  </div>
                  <div className="space-y-1 mt-0.5">
                    {group.items.map((item) => {
                      const active = pathname.startsWith(item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          role="menuitem"
                          className={
                            "flex items-start gap-2.5 rounded-xl p-2 font-display text-sm transition focus-visible:outline-2 focus-visible:outline-frog " +
                            (active
                              ? "bg-pond text-frog-dark font-extrabold"
                              : "text-ink hover:bg-surface-soft")
                          }
                        >
                          <span className="text-lg leading-none mt-0.5" aria-hidden="true">
                            {item.emoji}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="font-extrabold leading-tight">{item.label}</div>
                            <div className="text-xs font-semibold text-ink-soft truncate mt-0.5">
                              {item.desc}
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Mobile / Tablet Controls (< lg) */}
      <div className="flex min-w-0 items-center gap-2 lg:hidden">
        {/* Mobile Menu Button */}
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          aria-label="Open navigation menu"
          className="flex min-w-0 max-w-[9.5rem] items-center gap-1.5 whitespace-nowrap rounded-xl border-2 border-cardline bg-surface px-2.5 py-1.5 font-display text-sm font-extrabold text-ink transition hover:bg-pond/60 focus-visible:outline-2 focus-visible:outline-frog sm:gap-2 sm:px-3"
        >
          <span className="hidden text-base leading-none min-[400px]:inline" aria-hidden="true">
            {currentActiveEmoji}
          </span>
          <span className="truncate font-extrabold">{currentActiveLabel}</span>
          <svg
            className="h-4 w-4 text-ink-soft ml-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      {/* Mobile Navigation Drawer Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-surface/98 backdrop-blur-md animate-pop lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Mobile Navigation Menu"
        >
          {/* Drawer Header */}
          <div className="flex items-center justify-between border-b-2 border-cardline p-4 bg-surface">
            <div className="flex items-center gap-2">
              <span className="text-xl" aria-hidden="true">
                🧭
              </span>
              <span className="font-display text-lg font-extrabold text-ink">
                Command Navigation
              </span>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation menu"
              className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-cardline bg-surface font-display text-base font-extrabold text-ink hover:bg-danger-bg hover:text-danger-ink transition focus-visible:outline-2 focus-visible:outline-frog"
            >
              ✕
            </button>
          </div>

          {/* Drawer Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {/* Primary Desk */}
            <div>
              <div className="px-1 mb-2 text-xs font-extrabold uppercase tracking-wider text-ink-soft">
                Core Operations
              </div>
              <div className="grid gap-2">
                {PRIMARY_TABS.map((t) => {
                  const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
                  return (
                    <Link
                      key={t.href}
                      href={t.href}
                      className={
                        "flex items-center gap-3 rounded-2xl border-2 p-3 font-display transition " +
                        (active
                          ? "border-frog bg-pond text-frog-dark font-extrabold shadow-sm"
                          : "border-cardline bg-surface text-ink hover:bg-surface-soft")
                      }
                    >
                      <span className="text-2xl leading-none" aria-hidden="true">
                        {t.emoji}
                      </span>
                      <div>
                        <div className="font-extrabold text-base">{t.label}</div>
                        <div className="text-xs text-ink-soft font-semibold">{t.desc}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Categorized Tools */}
            {TOOL_GROUPS.map((group) => (
              <div key={group.category}>
                <div className="px-1 mb-2 text-xs font-extrabold uppercase tracking-wider text-ink-soft">
                  {group.category}
                </div>
                <div className="grid gap-2">
                  {group.items.map((item) => {
                    const active = pathname.startsWith(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={
                          "flex items-center gap-3 rounded-2xl border-2 p-3 font-display transition " +
                          (active
                            ? "border-frog bg-pond text-frog-dark font-extrabold shadow-sm"
                            : "border-cardline bg-surface text-ink hover:bg-surface-soft")
                        }
                      >
                        <span className="text-2xl leading-none" aria-hidden="true">
                          {item.emoji}
                        </span>
                        <div>
                          <div className="font-extrabold text-base">{item.label}</div>
                          <div className="text-xs text-ink-soft font-semibold">{item.desc}</div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
