"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const syncSystemTheme = () => {
    if (localStorage.getItem("daily-cart-theme")) return;
    document.documentElement.dataset.theme = media.matches ? "dark" : "light";
    onChange();
  };
  media.addEventListener("change", syncSystemTheme);
  window.addEventListener("daily-cart-theme", onChange);
  return () => {
    media.removeEventListener("change", syncSystemTheme);
    window.removeEventListener("daily-cart-theme", onChange);
  };
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);

  const dark = theme === "dark";
  const toggle = () => {
    const next: Theme = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("daily-cart-theme", next);
    window.dispatchEvent(new Event("daily-cart-theme"));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to day mode" : "Switch to night mode"}
      aria-pressed={dark}
      title={dark ? "Switch to day mode" : "Switch to night mode"}
      className="btn3d h-9 min-w-9 border-cardline bg-surface px-2 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frog"
    >
      <span className="theme-toggle-icon block" aria-hidden="true">
        {dark ? "☀️" : "🌙"}
      </span>
    </button>
  );
}
